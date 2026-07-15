"""Resident scientific paper acquisition worker: line-framed JSON over stdio.

The TypeScript research adapter keeps this worker alive and sends one JSON
request per stdin line. The worker writes one JSON response per stdout line:

  request  {"id": 1, "command": "fetch_and_parse", "ref": "1706.03762"}
           {"id": 2, "command": "retraction_status", "dois": ["10...."]}
  response {"id": 1, "ok": true, "result": {"metadata": {...}, ...}}
           {"id": 2, "ok": false, "error": "<Type>: <message>"}

Only protocol responses go to stdout. Parser chatter and tracebacks are kept on
stderr so line framing stays clean.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import traceback
import xml.etree.ElementTree as ET
from html import unescape
from typing import Any
from urllib.parse import quote

import requests

REAL_STDOUT = sys.stdout

CROSSREF_BASE_URL = "https://api.crossref.org"
ARXIV_API_URL = "https://export.arxiv.org/api/query"
SEMANTIC_SCHOLAR_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
SEMANTIC_SCHOLAR_FIELDS = "title,abstract,year,authors,externalIds,openAccessPdf,venue,citationCount"
OPENALEX_WORKS_URL = "https://api.openalex.org/works"
DEFAULT_TIMEOUT_SECONDS = 30
PDF_TIMEOUT_SECONDS = 60
DEFAULT_SEARCH_LIMIT = 10
MAX_SEARCH_LIMIT = 50
SEARCH_SOURCES = ("semanticScholar", "openAlex")

DOI_RE = re.compile(
    r"^(?:doi:\s*|https?://(?:dx\.)?doi\.org/)?(10\.\d{4,9}/\S+)$",
    re.IGNORECASE,
)
VERSIONED_ARXIV_RE = re.compile(r"^(.+?)v\d+$")
TAG_RE = re.compile(r"<[^>]+>")

STATUS_BY_UPDATE_TYPE = {
    "retraction": "retracted",
    "correction": "corrected",
    "corrigendum": "corrected",
    "erratum": "corrected",
    "expression_of_concern": "concern",
    "expression-of-concern": "concern",
    "concern": "concern",
    "removal": "withdrawn",
    "withdrawal": "withdrawn",
    "withdrawn": "withdrawn",
}
STATUS_PRIORITY = {
    "active": 0,
    "corrected": 1,
    "concern": 2,
    "withdrawn": 3,
    "retracted": 4,
}


class WorkerError(Exception):
    pass


def normalize_space(value: str) -> str:
    return " ".join(value.split())


def clean_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = unescape(TAG_RE.sub(" ", value))
    text = normalize_space(text)
    return text or None


def normalize_doi(value: str) -> str | None:
    match = DOI_RE.match(value.strip())
    if match is None:
        return None
    return match.group(1).rstrip(".,;").lower()


def normalize_arxiv_id(value: str) -> str:
    text = value.strip()
    text = re.sub(r"^https?://arxiv\.org/(abs|pdf)/", "", text, flags=re.IGNORECASE)
    text = text.removesuffix(".pdf")
    match = VERSIONED_ARXIV_RE.match(text)
    return match.group(1) if match is not None else text


def date_parts_to_iso(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    parts = value.get("date-parts")
    if not isinstance(parts, list) or len(parts) == 0:
        return None
    first = parts[0]
    if not isinstance(first, list) or len(first) == 0:
        return None
    try:
        year = int(first[0])
        month = int(first[1]) if len(first) > 1 else 1
        day = int(first[2]) if len(first) > 2 else 1
    except (TypeError, ValueError):
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"


def first_string(values: Any) -> str | None:
    if isinstance(values, list):
        for value in values:
            if isinstance(value, str) and value.strip() != "":
                return normalize_space(value)
    if isinstance(values, str) and values.strip() != "":
        return normalize_space(values)
    return None


def author_name(author: Any) -> str | None:
    if not isinstance(author, dict):
        return None
    literal = clean_text(author.get("name"))
    if literal is not None:
        return literal
    given = clean_text(author.get("given")) or ""
    family = clean_text(author.get("family")) or ""
    name = normalize_space(f"{given} {family}")
    return name or None


def user_agent() -> str:
    email = os.environ.get("OH_MY_GOALS_CROSSREF_EMAIL", "").strip()
    if email == "":
        return "oh-my-goals-research-worker/0.1"
    return f"oh-my-goals-research-worker/0.1 (mailto:{email})"


def http_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent()})
    return session


def crossref_work(session: requests.Session, doi: str) -> dict[str, Any]:
    params: dict[str, str] = {}
    email = os.environ.get("OH_MY_GOALS_CROSSREF_EMAIL", "").strip()
    if email != "":
        params["mailto"] = email
    url = f"{CROSSREF_BASE_URL}/works/{quote(doi, safe='')}"
    response = session.get(url, params=params, timeout=DEFAULT_TIMEOUT_SECONDS)
    response.raise_for_status()
    payload = response.json()
    message = payload.get("message")
    if not isinstance(message, dict):
        raise WorkerError("Crossref response is missing message")
    return message


def pdf_url_from_crossref(work: dict[str, Any]) -> str | None:
    links = work.get("link")
    if not isinstance(links, list):
        return None
    for link in links:
        if not isinstance(link, dict):
            continue
        url = link.get("URL")
        if not isinstance(url, str) or url.strip() == "":
            continue
        content_type = str(link.get("content-type", "")).lower()
        if "pdf" in content_type or "/pdf" in url.lower() or url.lower().endswith(".pdf"):
            return url
    return None


def metadata_from_crossref(work: dict[str, Any]) -> dict[str, Any]:
    doi = clean_text(work.get("DOI"))
    issued = work.get("issued") or work.get("published") or work.get("published-print")
    issued_date = date_parts_to_iso(issued)
    authors = [
        name
        for name in (author_name(author) for author in work.get("author", []))
        if name is not None
    ]
    metadata: dict[str, Any] = {
        "title": first_string(work.get("title")) or doi or "Untitled work",
    }
    if doi is not None:
        metadata["doi"] = doi.lower()
    if authors:
        metadata["authors"] = authors
    if issued_date is not None:
        metadata["year"] = int(issued_date[:4])
    venue = first_string(work.get("container-title"))
    if venue is not None:
        metadata["venue"] = venue
    abstract = clean_text(work.get("abstract"))
    if abstract is not None:
        metadata["abstract"] = abstract
    pdf_url = pdf_url_from_crossref(work)
    if pdf_url is not None:
        metadata["pdfUrl"] = pdf_url
    return metadata


def arxiv_text(entry: ET.Element, tag: str) -> str | None:
    found = entry.find(f"atom:{tag}", ARXIV_NS)
    if found is None or found.text is None:
        return None
    return clean_text(found.text)


ARXIV_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}


def metadata_from_arxiv(session: requests.Session, ref: str) -> dict[str, Any]:
    arxiv_id = normalize_arxiv_id(ref)
    response = session.get(
        ARXIV_API_URL,
        params={"id_list": arxiv_id},
        timeout=DEFAULT_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    root = ET.fromstring(response.text)
    entry = root.find("atom:entry", ARXIV_NS)
    if entry is None:
        raise WorkerError(f"arXiv returned no entry for {ref!r}")
    abs_url = arxiv_text(entry, "id")
    versioned_id = arxiv_id
    if abs_url is not None:
        versioned_id = abs_url.rstrip("/").rsplit("/", 1)[-1]
    base_id = normalize_arxiv_id(versioned_id)
    pdf_url = None
    for link in entry.findall("atom:link", ARXIV_NS):
        if link.attrib.get("title") == "pdf" or link.attrib.get("type") == "application/pdf":
            pdf_url = link.attrib.get("href")
            break
    if pdf_url is None:
        pdf_url = f"https://arxiv.org/pdf/{versioned_id}"
    authors = [
        normalize_space(name.text)
        for name in entry.findall("atom:author/atom:name", ARXIV_NS)
        if name.text is not None and name.text.strip() != ""
    ]
    published = arxiv_text(entry, "published")
    metadata: dict[str, Any] = {
        "title": arxiv_text(entry, "title") or base_id,
        "arxivId": base_id,
        "pdfUrl": pdf_url,
    }
    doi = arxiv_text(entry, "doi")
    if doi is not None:
        metadata["doi"] = doi.lower()
    if authors:
        metadata["authors"] = authors
    if published is not None and len(published) >= 4 and published[:4].isdigit():
        metadata["year"] = int(published[:4])
    abstract = arxiv_text(entry, "summary")
    if abstract is not None:
        metadata["abstract"] = abstract
    category = entry.find("arxiv:primary_category", ARXIV_NS)
    if category is not None and category.attrib.get("term"):
        metadata["venue"] = f"arXiv:{category.attrib['term']}"
    return metadata


def grobid_url() -> str | None:
    value = os.environ.get("OH_MY_GOALS_GROBID_URL", "").strip()
    return value.rstrip("/") if value != "" else None


def grobid_available(session: requests.Session, base_url: str) -> bool:
    try:
        response = session.get(f"{base_url}/api/isalive", timeout=5)
    except requests.RequestException:
        return False
    return response.ok and response.text.strip().lower() == "true"


def fetch_pdf(session: requests.Session, url: str) -> bytes:
    response = session.get(url, timeout=PDF_TIMEOUT_SECONDS)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "").lower()
    if "pdf" not in content_type and not response.content.startswith(b"%PDF"):
        raise WorkerError(f"PDF URL did not return a PDF: {url}")
    return response.content


def parse_pdf_with_grobid(pdf_bytes: bytes, base_url: str) -> dict[str, Any] | None:
    import scipdf

    return scipdf.parse_pdf_to_dict(
        pdf_bytes,
        fulltext=True,
        soup=True,
        as_list=False,
        return_coordinates=False,
        grobid_url=base_url,
    )


def normalize_section(section: Any) -> dict[str, str] | None:
    if not isinstance(section, dict):
        return None
    heading = clean_text(section.get("heading")) or ""
    text_value = section.get("text")
    if isinstance(text_value, list):
        text = "\n".join(clean_text(item) or "" for item in text_value)
    else:
        text = clean_text(text_value) or ""
    if heading == "" and text == "":
        return None
    return {"heading": heading, "text": text}


def normalize_reference(reference: Any) -> dict[str, str] | None:
    if not isinstance(reference, dict):
        return None
    title = clean_text(reference.get("title"))
    doi = clean_text(reference.get("doi") or reference.get("DOI"))
    raw = clean_text(reference.get("raw") or reference.get("unstructured"))
    if raw is None:
        pieces = [
            clean_text(reference.get("authors")),
            title,
            clean_text(reference.get("journal")),
            clean_text(reference.get("year")),
        ]
        raw = normalize_space(" ".join(piece for piece in pieces if piece is not None))
    if raw == "":
        return None
    out = {"raw": raw}
    if title is not None:
        out["title"] = title
    if doi is not None:
        out["doi"] = doi.lower()
    return out


def merge_parsed_metadata(metadata: dict[str, Any], parsed: dict[str, Any]) -> dict[str, Any]:
    out = dict(metadata)
    title = clean_text(parsed.get("title"))
    if (not out.get("title")) and title is not None:
        out["title"] = title
    abstract = clean_text(parsed.get("abstract"))
    if out.get("abstract") is None and abstract is not None:
        out["abstract"] = abstract
    doi = clean_text(parsed.get("doi"))
    if out.get("doi") is None and doi is not None:
        out["doi"] = doi.lower()
    return out


def fetch_and_parse(payload: dict[str, Any]) -> dict[str, Any]:
    ref = payload.get("ref")
    if not isinstance(ref, str) or ref.strip() == "":
        raise WorkerError("fetch_and_parse requires a nonblank ref")
    session = http_session()
    doi = normalize_doi(ref)
    if doi is not None:
        metadata = metadata_from_crossref(crossref_work(session, doi))
    else:
        metadata = metadata_from_arxiv(session, ref)

    base_url = grobid_url()
    if base_url is None or not grobid_available(session, base_url):
        return {"metadata": metadata, "sections": [], "references": []}

    pdf_url = metadata.get("pdfUrl")
    if not isinstance(pdf_url, str) or pdf_url.strip() == "":
        return {"metadata": metadata, "sections": [], "references": []}

    try:
        pdf_bytes = fetch_pdf(session, pdf_url)
        parsed = parse_pdf_with_grobid(pdf_bytes, base_url)
    except Exception as error:
        print(f"GROBID parse unavailable: {type(error).__name__}: {error}", file=sys.stderr)
        return {"metadata": metadata, "sections": [], "references": []}

    if not isinstance(parsed, dict):
        return {"metadata": metadata, "sections": [], "references": []}
    sections = [
        section
        for section in (normalize_section(section) for section in parsed.get("sections", []))
        if section is not None
    ]
    references = [
        reference
        for reference in (normalize_reference(reference) for reference in parsed.get("references", []))
        if reference is not None
    ]
    return {
        "metadata": merge_parsed_metadata(metadata, parsed),
        "sections": sections,
        "references": references,
    }


def iter_update_records(work: dict[str, Any]) -> list[dict[str, Any]]:
    updates: list[dict[str, Any]] = []
    for field in ("update-to", "updated-by"):
        value = work.get(field)
        if isinstance(value, list):
            updates.extend(update for update in value if isinstance(update, dict))
    relation = work.get("relation")
    if isinstance(relation, dict):
        for value in relation.values():
            if isinstance(value, list):
                updates.extend(update for update in value if isinstance(update, dict))
    return updates


def update_date(update: dict[str, Any]) -> str | None:
    updated = update.get("updated")
    if isinstance(updated, dict):
        date = date_parts_to_iso(updated)
        if date is not None:
            return date
        date_time = clean_text(updated.get("date-time"))
        if date_time is not None:
            return date_time[:10]
    return None


def update_notice(update: dict[str, Any]) -> str | None:
    label = clean_text(update.get("label"))
    doi = clean_text(update.get("DOI"))
    source = clean_text(update.get("source"))
    pieces = []
    if label is not None:
        pieces.append(label)
    if doi is not None:
        pieces.append(doi)
    if source is not None:
        pieces.append(source)
    return ": ".join(pieces) if pieces else None


def retraction_record(session: requests.Session, doi: str) -> dict[str, Any]:
    if not isinstance(doi, str):
        raise WorkerError("DOI entries must be strings")
    normalized = normalize_doi(doi)
    if normalized is None:
        raise WorkerError(f"invalid DOI: {doi!r}")
    work = crossref_work(session, normalized)
    selected_status = "active"
    selected_update: dict[str, Any] | None = None
    for update in iter_update_records(work):
        update_type = clean_text(update.get("type"))
        if update_type is None:
            continue
        status = STATUS_BY_UPDATE_TYPE.get(update_type.lower())
        if status is None:
            continue
        if STATUS_PRIORITY[status] > STATUS_PRIORITY[selected_status]:
            selected_status = status
            selected_update = update
    out = {"doi": normalized, "status": selected_status}
    if selected_update is not None:
        notice = update_notice(selected_update)
        date = update_date(selected_update)
        if notice is not None:
            out["notice"] = notice
        if date is not None:
            out["date"] = date
    return out


def retraction_status(payload: dict[str, Any]) -> list[dict[str, Any]]:
    dois = payload.get("dois")
    if not isinstance(dois, list):
        raise WorkerError("retraction_status requires a DOI array")
    session = http_session()
    return [retraction_record(session, doi) for doi in dois]


def openalex_id(value: Any) -> str | None:
    if not isinstance(value, str) or value.strip() == "":
        return None
    return value.rstrip("/").rsplit("/", 1)[-1] or None


def openalex_abstract(inverted: Any) -> str | None:
    """Reconstruct plain text from OpenAlex's {word: [positions]} inverted index."""
    if not isinstance(inverted, dict):
        return None
    positioned: list[tuple[int, str]] = []
    for word, indices in inverted.items():
        if not isinstance(word, str) or not isinstance(indices, list):
            continue
        for index in indices:
            if isinstance(index, int):
                positioned.append((index, word))
    if not positioned:
        return None
    positioned.sort(key=lambda pair: pair[0])
    return clean_text(" ".join(word for _, word in positioned))


def put_optional(target: dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        target[key] = value


def metadata_from_semantic_scholar(paper: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(paper, dict):
        return None
    title = clean_text(paper.get("title"))
    if title is None:
        return None
    external = paper.get("externalIds") if isinstance(paper.get("externalIds"), dict) else {}
    metadata: dict[str, Any] = {"title": title}
    doi = external.get("DOI")
    put_optional(metadata, "doi", normalize_doi(doi) if isinstance(doi, str) else None)
    arxiv = external.get("ArXiv")
    put_optional(metadata, "arxivId", normalize_arxiv_id(arxiv) if isinstance(arxiv, str) else None)
    put_optional(metadata, "semanticScholarId", clean_text(paper.get("paperId")))
    authors = [
        clean_text(author.get("name"))
        for author in paper.get("authors", [])
        if isinstance(author, dict) and clean_text(author.get("name")) is not None
    ]
    if authors:
        metadata["authors"] = authors
    year = paper.get("year")
    put_optional(metadata, "year", year if isinstance(year, int) else None)
    put_optional(metadata, "venue", clean_text(paper.get("venue")))
    put_optional(metadata, "abstract", clean_text(paper.get("abstract")))
    open_pdf = paper.get("openAccessPdf")
    if isinstance(open_pdf, dict):
        put_optional(metadata, "pdfUrl", clean_text(open_pdf.get("url")))
    return metadata


def metadata_from_openalex(work: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(work, dict):
        return None
    title = clean_text(work.get("title") or work.get("display_name"))
    if title is None:
        return None
    ids = work.get("ids") if isinstance(work.get("ids"), dict) else {}
    metadata: dict[str, Any] = {"title": title}
    doi = work.get("doi") or ids.get("doi")
    put_optional(metadata, "doi", normalize_doi(doi) if isinstance(doi, str) else None)
    put_optional(metadata, "openAlexId", openalex_id(ids.get("openalex") or work.get("id")))
    authors = [
        clean_text(entry.get("author", {}).get("display_name"))
        for entry in work.get("authorships", [])
        if isinstance(entry, dict)
        and isinstance(entry.get("author"), dict)
        and clean_text(entry["author"].get("display_name")) is not None
    ]
    if authors:
        metadata["authors"] = authors
    year = work.get("publication_year")
    put_optional(metadata, "year", year if isinstance(year, int) else None)
    location = work.get("primary_location") if isinstance(work.get("primary_location"), dict) else {}
    source = location.get("source") if isinstance(location.get("source"), dict) else {}
    put_optional(metadata, "venue", clean_text(source.get("display_name")))
    put_optional(metadata, "abstract", openalex_abstract(work.get("abstract_inverted_index")))
    best = work.get("best_oa_location") if isinstance(work.get("best_oa_location"), dict) else {}
    put_optional(metadata, "pdfUrl", clean_text(location.get("pdf_url") or best.get("pdf_url")))
    return metadata


def as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def search_semantic_scholar(session: requests.Session, query: str, limit: int) -> list[dict[str, Any]]:
    headers = {}
    api_key = os.environ.get("OH_MY_GOALS_S2_API_KEY", "").strip()
    if api_key != "":
        headers["x-api-key"] = api_key
    try:
        response = session.get(
            SEMANTIC_SCHOLAR_SEARCH_URL,
            params={"query": query, "limit": limit, "fields": SEMANTIC_SCHOLAR_FIELDS},
            headers=headers,
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json().get("data", [])
    except (requests.RequestException, ValueError) as error:
        print(f"Semantic Scholar search unavailable: {type(error).__name__}: {error}", file=sys.stderr)
        return []
    candidates = []
    for paper in data if isinstance(data, list) else []:
        metadata = metadata_from_semantic_scholar(paper)
        if metadata is None:
            continue
        candidate: dict[str, Any] = {"metadata": metadata, "source": "semanticScholar"}
        put_optional(candidate, "citationCount", as_int(paper.get("citationCount")))
        candidates.append(candidate)
    return candidates


def search_openalex(session: requests.Session, query: str, limit: int) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"search": query, "per-page": limit, "per_page": limit}
    email = os.environ.get("OH_MY_GOALS_OPENALEX_EMAIL", "").strip() or os.environ.get(
        "OH_MY_GOALS_CROSSREF_EMAIL", ""
    ).strip()
    if email != "":
        params["mailto"] = email
    try:
        response = session.get(OPENALEX_WORKS_URL, params=params, timeout=DEFAULT_TIMEOUT_SECONDS)
        response.raise_for_status()
        results = response.json().get("results", [])
    except (requests.RequestException, ValueError) as error:
        print(f"OpenAlex search unavailable: {type(error).__name__}: {error}", file=sys.stderr)
        return []
    candidates = []
    for work in results if isinstance(results, list) else []:
        metadata = metadata_from_openalex(work)
        if metadata is None:
            continue
        candidate: dict[str, Any] = {"metadata": metadata, "source": "openAlex"}
        put_optional(candidate, "citationCount", as_int(work.get("cited_by_count")))
        candidates.append(candidate)
    return candidates


def openalex_resolve(session: requests.Session, ref: str) -> dict[str, Any] | None:
    """The OpenAlex work for a DOI or arXiv id, or None when it is not found.

    OpenAlex keys works by DOI. An arXiv id is tried as its arXiv DOI (assigned
    only since 2022) and, failing that, as the paper's published DOI resolved from
    the arXiv record, so a published preprint still links up. An old arXiv-only
    paper that OpenAlex holds under neither DOI does not resolve here; its backward
    citations still come from the GROBID reference parse."""
    doi = normalize_doi(ref)
    dois: list[str] = []
    if doi is not None:
        dois.append(doi)
    else:
        arxiv = normalize_arxiv_id(ref)
        dois.append(f"10.48550/arxiv.{arxiv}")
        try:
            published = metadata_from_arxiv(session, ref).get("doi")
            if isinstance(published, str):
                dois.append(normalize_doi(published) or published)
        except (requests.RequestException, ValueError, WorkerError):
            pass
    params: dict[str, Any] = {}
    email = os.environ.get("OH_MY_GOALS_OPENALEX_EMAIL", "").strip() or os.environ.get(
        "OH_MY_GOALS_CROSSREF_EMAIL", ""
    ).strip()
    if email != "":
        params["mailto"] = email
    for candidate in dois:
        try:
            response = session.get(
                f"{OPENALEX_WORKS_URL}/doi:{candidate}", params=params, timeout=DEFAULT_TIMEOUT_SECONDS
            )
            if response.status_code == 200:
                work = response.json()
                if isinstance(work, dict):
                    return work
        except (requests.RequestException, ValueError):
            continue
    return None


def openalex_batch(session: requests.Session, filter_value: str, limit: int, sort: str | None) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"filter": filter_value, "per-page": limit, "per_page": limit}
    if sort is not None:
        params["sort"] = sort
    email = os.environ.get("OH_MY_GOALS_OPENALEX_EMAIL", "").strip() or os.environ.get(
        "OH_MY_GOALS_CROSSREF_EMAIL", ""
    ).strip()
    if email != "":
        params["mailto"] = email
    try:
        response = session.get(OPENALEX_WORKS_URL, params=params, timeout=DEFAULT_TIMEOUT_SECONDS)
        response.raise_for_status()
        results = response.json().get("results", [])
    except (requests.RequestException, ValueError) as error:
        print(f"OpenAlex citation query unavailable: {type(error).__name__}: {error}", file=sys.stderr)
        return []
    candidates = []
    for work in results if isinstance(results, list) else []:
        metadata = metadata_from_openalex(work)
        if metadata is None:
            continue
        candidate: dict[str, Any] = {"metadata": metadata, "source": "openAlex"}
        put_optional(candidate, "citationCount", as_int(work.get("cited_by_count")))
        candidates.append(candidate)
    return candidates


def citations(payload: dict[str, Any]) -> list[dict[str, Any]]:
    ref = payload.get("ref")
    if not isinstance(ref, str) or ref.strip() == "":
        raise WorkerError("citations requires a nonblank ref")
    direction = payload.get("direction", "references")
    if direction not in ("references", "citedBy"):
        raise WorkerError("citations direction must be references or citedBy")
    raw_limit = payload.get("limit", DEFAULT_SEARCH_LIMIT)
    limit = raw_limit if isinstance(raw_limit, int) and raw_limit > 0 else DEFAULT_SEARCH_LIMIT
    limit = min(limit, MAX_SEARCH_LIMIT)
    session = http_session()
    work = openalex_resolve(session, ref)
    if work is None:
        return []
    if direction == "references":
        referenced = work.get("referenced_works")
        ids = [openalex_id(entry) for entry in referenced] if isinstance(referenced, list) else []
        ids = [value for value in ids if value is not None][:limit]
        if not ids:
            return []
        return openalex_batch(session, f"openalex_id:{'|'.join(ids)}", limit, None)
    oaid = openalex_id(work.get("id"))
    if oaid is None:
        return []
    return openalex_batch(session, f"cites:{oaid}", limit, "cited_by_count:desc")


def search(payload: dict[str, Any]) -> list[dict[str, Any]]:
    query = payload.get("query")
    if not isinstance(query, str) or query.strip() == "":
        raise WorkerError("search requires a nonblank query")
    raw_limit = payload.get("limit", DEFAULT_SEARCH_LIMIT)
    limit = raw_limit if isinstance(raw_limit, int) and raw_limit > 0 else DEFAULT_SEARCH_LIMIT
    limit = min(limit, MAX_SEARCH_LIMIT)
    requested = payload.get("sources")
    sources = requested if isinstance(requested, list) and requested else list(SEARCH_SOURCES)
    session = http_session()
    candidates: list[dict[str, Any]] = []
    if "semanticScholar" in sources:
        candidates.extend(search_semantic_scholar(session, query, limit))
    if "openAlex" in sources:
        candidates.extend(search_openalex(session, query, limit))
    return candidates


def handle(payload: dict[str, Any]) -> dict[str, Any]:
    command = payload.get("command")
    request_id = payload.get("id")
    if command == "fetch_and_parse":
        return {"id": request_id, "ok": True, "result": fetch_and_parse(payload)}
    if command == "retraction_status":
        return {"id": request_id, "ok": True, "result": retraction_status(payload)}
    if command == "search":
        return {"id": request_id, "ok": True, "result": search(payload)}
    if command == "citations":
        return {"id": request_id, "ok": True, "result": citations(payload)}
    return {"id": request_id, "ok": False, "error": f"ValueError: unknown command {command!r}"}


def respond(obj: dict[str, Any]) -> None:
    json.dump(obj, REAL_STDOUT, ensure_ascii=False)
    REAL_STDOUT.write("\n")
    REAL_STDOUT.flush()


def main() -> None:
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        with contextlib.redirect_stdout(sys.stderr):
            try:
                payload = json.loads(line)
                if not isinstance(payload, dict):
                    raise WorkerError("request must be a JSON object")
                out = handle(payload)
            except Exception as error:
                request_id = None
                try:
                    if isinstance(payload, dict):
                        request_id = payload.get("id")
                except UnboundLocalError:
                    pass
                out = {
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                    "trace": traceback.format_exc(),
                }
        respond(out)


if __name__ == "__main__":
    main()

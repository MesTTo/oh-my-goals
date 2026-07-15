// The bibliographic fields a paper carries, shared by the acquisition metadata a
// worker resolves and the ingest input the memory stores. Only a title is ever
// required; everything here is what a resolver may or may not fill in.
export interface BibliographicFields {
  readonly doi?: string;
  readonly arxivId?: string;
  readonly openAlexId?: string;
  readonly semanticScholarId?: string;
  readonly authors?: readonly string[];
  readonly year?: number;
  readonly venue?: string;
  readonly abstract?: string;
  readonly pdfUrl?: string;
}

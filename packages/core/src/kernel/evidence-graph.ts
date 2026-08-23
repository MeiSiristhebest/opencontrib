import type { SmartPointer } from './contract.js';
import type { SmartPointerStore } from './pointer-store.js';

export interface EvidenceNode {
  uri: string;
  type: 'hotspot' | 'finding' | 'poc' | 'rule';
  title: string;
  targetFile: string;
}

export interface EvidenceEdge {
  fromUri: string;
  toUri: string;
  relation: 'points_to_hotspot' | 'reproduced_by_poc' | 'governed_by_rule';
}

export interface EvidenceChain {
  findingUri: string;
  hotspotUri?: string;
  pocUri?: string;
  ruleUri?: string;
  summary: string;
  pointers: SmartPointer[];
}

export class EvidenceGraph {
  private edges: EvidenceEdge[] = [];

  constructor(private pointerStore: SmartPointerStore) {}

  public link(fromUri: string, toUri: string, relation: EvidenceEdge['relation']): void {
    this.edges.push({ fromUri, toUri, relation });
  }

  public unlink(fromUri?: string, toUri?: string): void {
    if (fromUri && toUri) {
      this.edges = this.edges.filter((e) => !(e.fromUri === fromUri && e.toUri === toUri));
    } else if (fromUri) {
      this.edges = this.edges.filter((e) => e.fromUri !== fromUri && e.toUri !== fromUri);
    }
  }

  public clear(): void {
    this.edges = [];
  }

  public getEvidenceChain(findingUri: string): EvidenceChain | { error: 'NOT_FOUND'; uri: string } {
    const finding = this.pointerStore.get(findingUri);
    if (!finding) {
      return { error: 'NOT_FOUND', uri: findingUri };
    }
    const relatedEdges = this.edges.filter((e) => e.fromUri === findingUri || e.toUri === findingUri);

    let hotspotUri: string | undefined;
    let pocUri: string | undefined;
    let ruleUri: string | undefined;

    for (const edge of relatedEdges) {
      if (edge.relation === 'points_to_hotspot') {
        hotspotUri = edge.toUri.startsWith('ptr://hotspots') ? edge.toUri : edge.fromUri;
      } else if (edge.relation === 'reproduced_by_poc') {
        pocUri = edge.toUri.startsWith('ptr://poc') ? edge.toUri : edge.fromUri;
      } else if (edge.relation === 'governed_by_rule') {
        ruleUri = edge.toUri.startsWith('ptr://rules') ? edge.toUri : edge.fromUri;
      }
    }

    const pointers: SmartPointer[] = [];
    if (finding) pointers.push(finding);
    if (hotspotUri) {
      const h = this.pointerStore.get(hotspotUri);
      if (h) pointers.push(h);
    }
    if (pocUri) {
      const p = this.pointerStore.get(pocUri);
      if (p) pointers.push(p);
    }
    if (ruleUri) {
      const r = this.pointerStore.get(ruleUri);
      if (r) pointers.push(r);
    }

    return {
      findingUri,
      hotspotUri,
      pocUri,
      ruleUri,
      summary: `Evidence Chain for ${finding?.stub.title || findingUri}: ${pointers.length} linked artifact(s).`,
      pointers,
    };
  }
}

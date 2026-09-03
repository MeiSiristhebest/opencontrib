import * as fs from 'fs';
import * as path from 'path';
import { homedir as osHomedir } from 'os';
import type { ContributionRunPhase } from './types.js';
import { getOpenContribHome } from '../kernel/home.js';


export interface ActiveSessionData {
  runId: string;
  repoFullName: string;
  currentPhase: ContributionRunPhase;
  workspacePath?: string;
  issueNumber?: number;
  issueTitle?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export class ActiveSessionManager {
  private sessionFilePath: string;

  public static getActiveSession(customPath?: string): ActiveSessionData | null {
    return new ActiveSessionManager(customPath).getActiveSession();
  }

  public static getActiveRunId(customPath?: string): string | null {
    return new ActiveSessionManager(customPath).getActiveRunId();
  }

  constructor(customPath?: string) {
    this.sessionFilePath = customPath || path.join(getOpenContribHome(), '.opencontrib', 'active_session.json');
  }

  public getActiveSession(): ActiveSessionData | null {

    try {
      if (!fs.existsSync(this.sessionFilePath)) {
        return null;
      }
      const content = fs.readFileSync(this.sessionFilePath, 'utf8');
      return JSON.parse(content) as ActiveSessionData;
    } catch {
      return null;
    }
  }

  public getActiveRunId(): string | null {
    const session = this.getActiveSession();
    return session ? session.runId : null;
  }

  public setActiveSession(data: Partial<ActiveSessionData> & { runId: string; repoFullName: string }): ActiveSessionData {
    const current = this.getActiveSession() || ({} as Partial<ActiveSessionData>);
    const updated: ActiveSessionData = {
      runId: data.runId,
      repoFullName: data.repoFullName,
      currentPhase: data.currentPhase || current.currentPhase || 'INITIALIZED',
      workspacePath: data.workspacePath !== undefined ? data.workspacePath : current.workspacePath,
      issueNumber: data.issueNumber !== undefined ? data.issueNumber : current.issueNumber,
      issueTitle: data.issueTitle !== undefined ? data.issueTitle : current.issueTitle,
      updatedAt: new Date().toISOString(),
      metadata: { ...(current.metadata || {}), ...(data.metadata || {}) },
    };

    const dir = path.dirname(this.sessionFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.sessionFilePath, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  }

  public updatePhase(phase: ContributionRunPhase): ActiveSessionData | null {
    const current = this.getActiveSession();
    if (!current) return null;
    return this.setActiveSession({ ...current, currentPhase: phase });
  }

  public updateWorkspacePath(workspacePath: string): ActiveSessionData | null {
    const current = this.getActiveSession();
    if (!current) return null;
    return this.setActiveSession({ ...current, workspacePath });
  }

  public clearActiveSession(): boolean {
    try {
      if (fs.existsSync(this.sessionFilePath)) {
        fs.unlinkSync(this.sessionFilePath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

export const defaultActiveSessionManager = new ActiveSessionManager();

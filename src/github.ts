// ─────────────────────────────────────────────────────────────────
// agentic-mcp-server / src/github.ts
// Thin GitHub REST API client — runs inside the Cloudflare Worker.
// All calls use GITHUB_TOKEN (PAT) stored as a Worker secret.
// ─────────────────────────────────────────────────────────────────

import type { GitHubPR } from "./types";

export class GitHubClient {
  private readonly token: string;
  private readonly base = "https://api.github.com";

  constructor(githubToken: string) {
    this.token = githubToken;
  }

  /** Parse "owner/repo" string into parts */
  private parseRepo(githubRepo: string): { owner: string; repo: string } {
    const [owner, repo] = githubRepo.split("/");
    if (!owner || !repo) throw new Error(`repo must be "owner/repo", got: ${githubRepo}`);
    return { owner, repo };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agentic-mcp-server/1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${err}`);
    }
    return res.json() as Promise<T>;
  }

  /** Get basic repo info */
  async getRepoInfo(githubRepo: string): Promise<{ defaultBranch: string; fullName: string; description: string }> {
    const { owner, repo } = this.parseRepo(githubRepo);
    const data: any = await this.request("GET", `/repos/${owner}/${repo}`);
    return { defaultBranch: data.default_branch, fullName: data.full_name, description: data.description ?? "" };
  }

  /** Create a branch off another (defaults to repo default branch) */
  async createBranch(githubRepo: string, branchName: string, fromBranch?: string): Promise<{ name: string; sha: string }> {
    // Get ref SHA to branch from
    const baseBranch = fromBranch ?? (await this.getRepoInfo(githubRepo)).defaultBranch;
    const { owner, repo } = this.parseRepo(githubRepo);
    const refData: any = await this.request("GET", `/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`);
    const sha = refData.object.sha;
    // Create new branch
    await this.request("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha,
    });
    return { name: branchName, sha };
  }

  /** Open a pull request */
  async openPullRequest(githubRepo: string, opts: {
    title: string;
    body: string;
    head: string;       // feature branch
    base?: string;      // defaults to repo default branch
    draft?: boolean;
    reviewers?: string[];
  }): Promise<GitHubPR> {
    const base = opts.base ?? (await this.getRepoInfo(githubRepo)).defaultBranch;
    const { owner, repo } = this.parseRepo(githubRepo);
    const pr: any = await this.request("POST", `/repos/${owner}/${repo}/pulls`, {
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base,
      draft: opts.draft ?? false,
    });
    if (opts.reviewers && opts.reviewers.length > 0) {
      await this.request("POST", `/repos/${owner}/${repo}/pulls/${pr.number}/requested_reviewers`, {
        reviewers: opts.reviewers,
      }).catch(() => {}); // non-fatal
    }
    return this.mapPR(pr);
  }

  /** Get a PR by number */
  async getPullRequest(githubRepo: string, prNumber: number): Promise<GitHubPR> {
    const { owner, repo } = this.parseRepo(githubRepo);
    const pr: any = await this.request("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
    return this.mapPR(pr);
  }

  /** List open PRs — optionally filter by head branch */
  async listOpenPRs(githubRepo: string, headBranch?: string): Promise<GitHubPR[]> {
    const { owner, repo } = this.parseRepo(githubRepo);
    const params = new URLSearchParams({ state: "open", per_page: "30" });
    if (headBranch) params.set("head", `${owner}:${headBranch}`);
    const prs: any[] = await this.request("GET", `/repos/${owner}/${repo}/pulls?${params}`);
    return prs.map(pr => this.mapPR(pr));
  }

  /** Add a comment to a PR */
  async addPRComment(githubRepo: string, prNumber: number, body: string): Promise<{ id: number; url: string }> {
    const { owner, repo } = this.parseRepo(githubRepo);
    const data: any = await this.request("POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body });
    return { id: data.id, url: data.html_url };
  }

  /** Merge a PR */
  async mergePullRequest(githubRepo: string, prNumber: number, opts?: { mergeMethod?: "merge" | "squash" | "rebase"; commitTitle?: string; commitMessage?: string }): Promise<{ merged: boolean; sha: string; message: string }> {
    const { owner, repo } = this.parseRepo(githubRepo);
    const data: any = await this.request("PUT", `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      merge_method: opts?.mergeMethod ?? "squash",
      commit_title: opts?.commitTitle,
      commit_message: opts?.commitMessage,
    });
    return { merged: data.merged, sha: data.sha, message: data.message };
  }

  /** Get review status of a PR */
  async getPRReviews(githubRepo: string, prNumber: number): Promise<{ state: string; reviewer: string }[]> {
    const { owner, repo } = this.parseRepo(githubRepo);
    const reviews: any[] = await this.request("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
    // return only the latest review per reviewer
    const latest = new Map<string, string>();
    for (const r of reviews) latest.set(r.user.login, r.state);
    return Array.from(latest.entries()).map(([reviewer, state]) => ({ reviewer, state }));
  }

  private mapPR(pr: any): GitHubPR {
    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      state: pr.merged_at ? "merged" : (pr.state as "open" | "closed"),
      draft: pr.draft ?? false,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      author: pr.user?.login ?? "unknown",
      headBranch: pr.head?.ref ?? "",
      baseBranch: pr.base?.ref ?? "",
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      comments: pr.comments ?? 0,
      reviewers: (pr.requested_reviewers ?? []).map((r: any) => r.login),
    };
  }
}

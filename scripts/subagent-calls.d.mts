export declare const SUBAGENT_TOOLS: Set<string>;

export type NestableCall = {
  t: number;
  tool: string;
  preview: string;
  full?: string;
  agentId?: string;
  orphan?: boolean;
  agentLabel?: string;
  agentRun?: { model: string | null; effort: string | null };
  children?: NestableCall[];
};

export type SubagentRun = {
  agentId?: string | null;
  prompt?: string | null;
  firstT: number;
  label?: string | null;
  model?: string | null;
  effort?: string | null;
  calls: NestableCall[];
};

export declare function nestSubagentCalls<T extends NestableCall>(main: T[], subs: SubagentRun[]): T[];

export declare function countNestedCalls(seq: ReadonlyArray<{ orphan?: boolean; children?: ReadonlyArray<unknown> }>): number;

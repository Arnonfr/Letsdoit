// ── Comment Status ──────────────────────────────────────────────
export type CommentStatus =
  | 'pending'
  | 'proposal_ready'
  | 'needs_clarification'
  | 'applied'
  | 'skipped';

// ── Comment Type (AI classified) ───────────────────────────────
export type CommentType =
  | 'text_change'
  | 'color_change'
  | 'delete_hide'
  | 'duplicate'
  | 'unknown';

// ── Allowed Actions (V1 – strict list) ────────────────────────
export type ActionType =
  | 'change_text'
  | 'change_color'
  | 'delete_node'
  | 'hide_node'
  | 'duplicate_node';

export type Confidence = 'high' | 'low';

// ── Proposed Action ────────────────────────────────────────────
export interface ProposedAction {
  type: ActionType;
  nodeId: string;
  params: Record<string, unknown>;
  description: string;
}

// ── AI Proposal ────────────────────────────────────────────────
export interface Proposal {
  confidence: Confidence;
  actions: ProposedAction[];
  explanation: string;
  commentType: CommentType;
}

// ── Comment Item ───────────────────────────────────────────────
export interface CommentItem {
  id: string;
  message: string;
  author: string;
  authorAvatar: string;
  pageOrFrame: string;
  status: CommentStatus;
  commentType: CommentType;
  nodeId: string | null;
  proposal: Proposal | null;
  resolved: boolean;
  createdAt: string;
}

// ── Node Info ──────────────────────────────────────────────────
export interface NodeInfo {
  id: string;
  type: string;
  name: string;
  text?: string;
  fills?: Array<{
    type: string;
    color?: { r: number; g: number; b: number };
    opacity?: number;
  }>;
  visible: boolean;
  locked: boolean;
  parentName?: string;
}

// ── Messages: UI → Plugin Code ─────────────────────────────────
export type UIMessage =
  | { type: 'get-file-key' }
  | { type: 'get-node-info'; nodeId: string }
  | { type: 'select-node'; nodeId: string }
  | { type: 'execute-action'; action: ProposedAction }
  | { type: 'store-get'; key: string }
  | { type: 'store-set'; key: string; value: string };

// ── Messages: Plugin Code → UI ─────────────────────────────────
export type PluginMessage =
  | { type: 'file-key'; fileKey: string }
  | { type: 'node-info'; nodeId: string; info: NodeInfo | null }
  | { type: 'node-selected'; nodeId: string; success: boolean }
  | { type: 'action-executed'; success: boolean; error?: string }
  | { type: 'store-value'; key: string; value: string | null }
  | { type: 'store-saved'; key: string };

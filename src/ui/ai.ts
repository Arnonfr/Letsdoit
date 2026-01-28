import type { Proposal, NodeInfo, ActionType, CommentType } from '../types';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You are a Figma design assistant. Your job is to analyze design review comments and propose specific, actionable changes.

ALLOWED ACTIONS (you may ONLY propose these):
- change_text: Change the text content of a text node. Params: { "newText": "string" }
- change_color: Change the fill color of a node. Params: { "color": { "r": 0-255, "g": 0-255, "b": 0-255 } }
- delete_node: Delete a node from the canvas. Params: {}
- hide_node: Hide a node (make invisible). Params: {}
- duplicate_node: Duplicate a node. Params: {}

RULES:
1. Only propose actions from the allowed list above.
2. If the comment does not clearly map to any allowed action, return confidence "low" and comment_type "unknown" with an empty actions array.
3. Be conservative — if you're not sure, set confidence to "low".
4. Return ONLY valid JSON, no markdown fences, no explanation outside the JSON.
5. For color changes, interpret color names (e.g. "blue" = {"r":37,"g":99,"b":235}, "red" = {"r":220,"g":38,"b":38}, "green" = {"r":22,"g":163,"b":74}, "black" = {"r":0,"g":0,"b":0}, "white" = {"r":255,"g":255,"b":255}).

RESPONSE FORMAT (strict JSON):
{
  "confidence": "high" | "low",
  "comment_type": "text_change" | "color_change" | "delete_hide" | "duplicate" | "unknown",
  "actions": [
    {
      "type": "<action_type>",
      "params": { ... },
      "description": "Human-readable description of this action"
    }
  ],
  "explanation": "One sentence explaining the reasoning"
}`;

function buildUserMessage(commentText: string, nodeInfo: NodeInfo | null): string {
  let msg = `COMMENT: "${commentText}"\n\n`;

  if (nodeInfo) {
    msg += `TARGET NODE:\n`;
    msg += `- Type: ${nodeInfo.type}\n`;
    msg += `- Name: "${nodeInfo.name}"\n`;
    if (nodeInfo.text !== undefined) {
      msg += `- Current text: "${nodeInfo.text}"\n`;
    }
    if (nodeInfo.fills && nodeInfo.fills.length > 0) {
      const solidFill = nodeInfo.fills.find(f => f.type === 'SOLID' && f.color);
      if (solidFill && solidFill.color) {
        const c = solidFill.color;
        msg += `- Current color: rgb(${c.r}, ${c.g}, ${c.b})\n`;
      }
    }
    msg += `- Visible: ${nodeInfo.visible}\n`;
    if (nodeInfo.parentName) {
      msg += `- Parent frame: "${nodeInfo.parentName}"\n`;
    }
  } else {
    msg += `TARGET NODE: No specific node linked to this comment.\n`;
  }

  msg += `\nPropose the appropriate action(s) based on the comment. Return ONLY JSON.`;
  return msg;
}

function parseAIResponse(text: string, nodeId: string): Proposal {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(cleaned);

  // Validate and map actions
  const allowedTypes: ActionType[] = [
    'change_text', 'change_color', 'delete_node', 'hide_node', 'duplicate_node',
  ];

  const actions = (parsed.actions || [])
    .filter((a: { type: string }) => allowedTypes.includes(a.type as ActionType))
    .map((a: { type: ActionType; params: Record<string, unknown>; description: string }) => ({
      type: a.type,
      nodeId,
      params: a.params || {},
      description: a.description || '',
    }));

  const validTypes: CommentType[] = [
    'text_change', 'color_change', 'delete_hide', 'duplicate', 'unknown',
  ];

  return {
    confidence: parsed.confidence === 'high' ? 'high' : 'low',
    commentType: validTypes.includes(parsed.comment_type) ? parsed.comment_type : 'unknown',
    actions,
    explanation: parsed.explanation || '',
  };
}

/** Quick classification without full proposal (for inbox badges) */
export async function classifyComment(
  apiKey: string,
  commentText: string
): Promise<CommentType> {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Classify this Figma design comment into ONE category. Reply with ONLY the category name, nothing else.\n\nCategories: text_change, color_change, delete_hide, duplicate, unknown\n\nComment: "${commentText}"`,
        },
      ],
    }),
  });

  if (!response.ok) {
    return 'unknown';
  }

  const data = await response.json();
  const result = (data.content?.[0]?.text || '').trim().toLowerCase();

  const validTypes: CommentType[] = [
    'text_change', 'color_change', 'delete_hide', 'duplicate', 'unknown',
  ];

  return validTypes.includes(result as CommentType)
    ? (result as CommentType)
    : 'unknown';
}

/** Full analysis: given a comment and node info, return a proposal */
export async function analyzeComment(
  apiKey: string,
  commentText: string,
  nodeId: string,
  nodeInfo: NodeInfo | null
): Promise<Proposal> {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildUserMessage(commentText, nodeInfo),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  return parseAIResponse(text, nodeId);
}

/** Re-analyze with user's edited instruction */
export async function reAnalyzeComment(
  apiKey: string,
  originalComment: string,
  userEdit: string,
  nodeId: string,
  nodeInfo: NodeInfo | null
): Promise<Proposal> {
  const combinedComment = `Original comment: "${originalComment}"\n\nUser clarification: "${userEdit}"`;
  return analyzeComment(apiKey, combinedComment, nodeId, nodeInfo);
}

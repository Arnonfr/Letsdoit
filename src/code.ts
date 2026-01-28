/// <reference types="@figma/plugin-typings" />

import type { UIMessage, NodeInfo, ProposedAction } from './types';

// ── Show UI ────────────────────────────────────────────────────
figma.showUI(__html__, { width: 380, height: 560, themeColors: true });

// ── Send file key on startup ───────────────────────────────────
figma.ui.postMessage({ type: 'file-key', fileKey: figma.fileKey });

// ── Node Info Helper ───────────────────────────────────────────
function getNodeInfo(nodeId: string): NodeInfo | null {
  const node = figma.getNodeById(nodeId);
  if (!node || node.removed) return null;

  const info: NodeInfo = {
    id: node.id,
    type: node.type,
    name: node.name,
    visible: 'visible' in node ? (node as SceneNode).visible : true,
    locked: 'locked' in node ? (node as SceneNode).locked : false,
  };

  // Text content
  if (node.type === 'TEXT') {
    info.text = (node as TextNode).characters;
  }

  // Fill colors
  if ('fills' in node) {
    const fills = (node as GeometryMixin).fills;
    if (Array.isArray(fills)) {
      info.fills = fills.map((f) => {
        if (f.type === 'SOLID') {
          return {
            type: f.type,
            color: {
              r: Math.round(f.color.r * 255),
              g: Math.round(f.color.g * 255),
              b: Math.round(f.color.b * 255),
            },
            opacity: f.opacity,
          };
        }
        return { type: f.type };
      });
    }
  }

  // Parent name
  if (node.parent && node.parent.type !== 'PAGE') {
    info.parentName = node.parent.name;
  }

  return info;
}

// ── Select & Zoom to Node ──────────────────────────────────────
function selectNode(nodeId: string): boolean {
  const node = figma.getNodeById(nodeId);
  if (!node || node.removed || !('type' in node)) return false;

  const sceneNode = node as SceneNode;
  figma.currentPage.selection = [sceneNode];
  figma.viewport.scrollAndZoomIntoView([sceneNode]);
  return true;
}

// ── Execute Allowed Action ─────────────────────────────────────
async function executeAction(
  action: ProposedAction
): Promise<{ success: boolean; error?: string }> {
  const node = figma.getNodeById(action.nodeId);
  if (!node || node.removed) {
    return { success: false, error: 'Node not found or has been removed' };
  }

  try {
    switch (action.type) {
      // ── Change Text ──
      case 'change_text': {
        if (node.type !== 'TEXT') {
          return { success: false, error: 'Node is not a text element' };
        }
        const textNode = node as TextNode;
        // Load font(s)
        if (textNode.fontName === figma.mixed) {
          const len = textNode.characters.length;
          for (let i = 0; i < len; i++) {
            await figma.loadFontAsync(
              textNode.getRangeFontName(i, i + 1) as FontName
            );
          }
        } else {
          await figma.loadFontAsync(textNode.fontName as FontName);
        }
        textNode.characters = String(action.params.newText);
        return { success: true };
      }

      // ── Change Color ──
      case 'change_color': {
        if (!('fills' in node)) {
          return { success: false, error: 'Node does not support fills' };
        }
        const color = action.params.color as {
          r: number;
          g: number;
          b: number;
        };
        const geometryNode = node as GeometryMixin;
        geometryNode.fills = [
          {
            type: 'SOLID',
            color: {
              r: color.r / 255,
              g: color.g / 255,
              b: color.b / 255,
            },
          },
        ];
        return { success: true };
      }

      // ── Delete Node ──
      case 'delete_node': {
        node.remove();
        return { success: true };
      }

      // ── Hide Node ──
      case 'hide_node': {
        if (!('visible' in node)) {
          return { success: false, error: 'Node does not support visibility' };
        }
        (node as SceneNode).visible = false;
        return { success: true };
      }

      // ── Duplicate Node ──
      case 'duplicate_node': {
        if (!('clone' in node)) {
          return { success: false, error: 'Node cannot be duplicated' };
        }
        (node as SceneNode).clone();
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action: ${action.type}` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

// ── Message Handler ────────────────────────────────────────────
figma.ui.onmessage = async (msg: UIMessage) => {
  switch (msg.type) {
    case 'get-file-key': {
      figma.ui.postMessage({ type: 'file-key', fileKey: figma.fileKey });
      break;
    }

    case 'get-node-info': {
      const info = getNodeInfo(msg.nodeId);
      figma.ui.postMessage({ type: 'node-info', nodeId: msg.nodeId, info });
      break;
    }

    case 'select-node': {
      const success = selectNode(msg.nodeId);
      figma.ui.postMessage({
        type: 'node-selected',
        nodeId: msg.nodeId,
        success,
      });
      break;
    }

    case 'execute-action': {
      const result = await executeAction(msg.action);
      figma.ui.postMessage({ type: 'action-executed', ...result });
      break;
    }

    case 'store-get': {
      const value = await figma.clientStorage.getAsync(msg.key);
      figma.ui.postMessage({
        type: 'store-value',
        key: msg.key,
        value: value ?? null,
      });
      break;
    }

    case 'store-set': {
      await figma.clientStorage.setAsync(msg.key, msg.value);
      figma.ui.postMessage({ type: 'store-saved', key: msg.key });
      break;
    }
  }
};

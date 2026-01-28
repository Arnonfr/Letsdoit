"use strict";
(() => {
  // src/code.ts
  function getNodeInfo(nodeId) {
    const node = figma.getNodeById(nodeId);
    if (!node || node.removed) return null;
    const info = {
      id: node.id,
      type: node.type,
      name: node.name,
      visible: "visible" in node ? node.visible : true,
      locked: "locked" in node ? node.locked : false
    };
    if (node.type === "TEXT") {
      info.text = node.characters;
    }
    if ("fills" in node) {
      const fills = node.fills;
      if (Array.isArray(fills)) {
        info.fills = fills.map((f) => {
          if (f.type === "SOLID") {
            return {
              type: f.type,
              color: {
                r: Math.round(f.color.r * 255),
                g: Math.round(f.color.g * 255),
                b: Math.round(f.color.b * 255)
              },
              opacity: f.opacity
            };
          }
          return { type: f.type };
        });
      }
    }
    if (node.parent && node.parent.type !== "PAGE") {
      info.parentName = node.parent.name;
    }
    return info;
  }
  function selectNode(nodeId) {
    const node = figma.getNodeById(nodeId);
    if (!node || node.removed || !("type" in node)) return false;
    const sceneNode = node;
    figma.currentPage.selection = [sceneNode];
    figma.viewport.scrollAndZoomIntoView([sceneNode]);
    return true;
  }
  async function executeAction(action) {
    const node = figma.getNodeById(action.nodeId);
    if (!node || node.removed) {
      return { success: false, error: "Node not found or has been removed" };
    }
    try {
      switch (action.type) {
        case "change_text": {
          if (node.type !== "TEXT") {
            return { success: false, error: "Node is not a text element" };
          }
          const textNode = node;
          if (textNode.fontName === figma.mixed) {
            const len = textNode.characters.length;
            for (let i = 0; i < len; i++) {
              await figma.loadFontAsync(
                textNode.getRangeFontName(i, i + 1)
              );
            }
          } else {
            await figma.loadFontAsync(textNode.fontName);
          }
          textNode.characters = String(action.params.newText);
          return { success: true };
        }
        case "change_color": {
          if (!("fills" in node)) {
            return { success: false, error: "Node does not support fills" };
          }
          const color = action.params.color;
          const geometryNode = node;
          geometryNode.fills = [
            {
              type: "SOLID",
              color: {
                r: color.r / 255,
                g: color.g / 255,
                b: color.b / 255
              }
            }
          ];
          return { success: true };
        }
        case "delete_node": {
          node.remove();
          return { success: true };
        }
        case "hide_node": {
          if (!("visible" in node)) {
            return { success: false, error: "Node does not support visibility" };
          }
          node.visible = false;
          return { success: true };
        }
        case "duplicate_node": {
          if (!("clone" in node)) {
            return { success: false, error: "Node cannot be duplicated" };
          }
          node.clone();
          return { success: true };
        }
        default:
          return { success: false, error: `Unknown action: ${action.type}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
  figma.ui.onmessage = async (msg) => {
    switch (msg.type) {
      case "get-file-key": {
        figma.ui.postMessage({
          type: "file-key",
          fileKey: figma.fileKey ?? ""
        });
        break;
      }
      case "get-node-info": {
        const info = getNodeInfo(msg.nodeId);
        figma.ui.postMessage({ type: "node-info", nodeId: msg.nodeId, info });
        break;
      }
      case "select-node": {
        const success = selectNode(msg.nodeId);
        figma.ui.postMessage({
          type: "node-selected",
          nodeId: msg.nodeId,
          success
        });
        break;
      }
      case "execute-action": {
        const result = await executeAction(msg.action);
        figma.ui.postMessage({ type: "action-executed", ...result });
        break;
      }
      case "store-get": {
        try {
          const value = await figma.clientStorage.getAsync(msg.key);
          figma.ui.postMessage({
            type: "store-value",
            key: msg.key,
            value: value ?? null
          });
        } catch {
          figma.ui.postMessage({
            type: "store-value",
            key: msg.key,
            value: null
          });
        }
        break;
      }
      case "store-set": {
        try {
          await figma.clientStorage.setAsync(msg.key, msg.value);
        } catch {
        }
        figma.ui.postMessage({ type: "store-saved", key: msg.key });
        break;
      }
    }
  };
  figma.showUI(__html__, { width: 380, height: 560, themeColors: true });
})();

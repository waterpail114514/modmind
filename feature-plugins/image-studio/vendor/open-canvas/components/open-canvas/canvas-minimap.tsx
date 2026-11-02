"use client";

import { memo, useCallback } from "react";
import { MiniMap, useReactFlow, type MiniMapNodeProps } from "@xyflow/react";
import { useCanvasStore } from "./upstream/shared/stores/canvas-store";
import type { CanvasFlowNode } from "./upstream/shared/lib/canvas/serialization";

const colors = { image: '#66ad88', video: '#8c8acb', text: '#789fc2', note: '#c1a269', audio: '#c18b9e' };
const nodeColor = (node: CanvasFlowNode) => colors[node.data.nodeType];
const MapNode = memo(function MapNode({ id, x, y, width, height, color }: MiniMapNodeProps) {
  const title = useCanvasStore(state => state.nodes.find(node => node.id === id)?.data.title || '');
  return <g><rect x={x} y={y} width={width} height={height} fill={color} rx={4} /><text x={x + 5} y={y + Math.min(20, height / 2)} fill="#17251c" fontSize={12}>{title}</text></g>;
});

export const CanvasMiniMap = memo(function CanvasMiniMap({ light }: { light: boolean }) {
  const flow = useReactFlow();
  const center = useCallback((_event: React.MouseEvent, position: { x: number; y: number }) => {
    void flow.setCenter(position.x, position.y, { zoom: flow.getZoom(), duration: 180 });
  }, [flow]);
  return <MiniMap<CanvasFlowNode> position="bottom-left" pannable zoomable onClick={center} className="oc-minimap" style={{ width: 240, height: 160 }} bgColor={light ? '#e2e2e2' : '#202020'} maskColor={light ? 'rgba(90,90,90,.13)' : 'rgba(0,0,0,.28)'} maskStrokeColor={light ? '#777' : '#aaa'} maskStrokeWidth={1.5} nodeColor={nodeColor} nodeComponent={MapNode} />;
});

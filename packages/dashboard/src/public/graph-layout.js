// Layout and force simulation for the memory graph view. Pure functions with no DOM access, so the
// same code is unit-tested and benchmarked in Node and served to the browser as-is.
//
// The simulation used to compare every node with every other node each frame and look nodes up by id
// with Array.find per edge, both per frame and forever: on a 7.9k-node graph one frame cost 450-740 ms
// of computation before any drawing. It now uses a Barnes-Hut tree for repulsion, direct node
// references for edges, and a cooling schedule that lets the layout settle and stop.

export const GRAPH_REPULSION = 1800;
export const GRAPH_SPRING_LENGTH = 70;
export const GRAPH_SPRING_STRENGTH = 0.03;
export const GRAPH_DAMPING = 0.85;
export const GRAPH_ANCHOR_STRENGTH = 0.025;
export const GRAPH_MAX_SPEED = 8;
export const GRAPH_GOLDEN_ANGLE = 2.399963;
export const CLUSTER_COLORS = ["#4d6b58", "#4a6fa5", "#a5674a", "#7a4a9c", "#4a9c8a", "#9c4a6f", "#8a9c4a", "#4a5f9c"];
export const SOLO_NODE_COLOR = "#b7bab6";

/** Barnes-Hut opening angle: a cell counts as one body once its size / distance falls below this. */
export const GRAPH_THETA = 0.9;
/** Coincident nodes would subdivide forever, so cells this deep hold several bodies directly. */
export const GRAPH_TREE_MAX_DEPTH = 24;
/** Forces are scaled by alpha, which decays every step; the layout is settled below GRAPH_ALPHA_MIN. */
export const GRAPH_ALPHA_DECAY = 0.985;
export const GRAPH_ALPHA_MIN = 0.01;

/** Lightens a "#rrggbb" color toward white by `amount` (0-1), for legible labels that still carry the node's cluster hue. */
export function lightenHexColor(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** Union-find over edges: nodes connected (directly or transitively) belong to the same cluster. */
export function computeGraphClusters(nodes, edges) {
  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (id) => {
    while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
    return id;
  };
  for (const edge of edges) {
    if (!parent.has(edge.source) || !parent.has(edge.target)) continue;
    const rootA = find(edge.source), rootB = find(edge.target);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }
  const groups = new Map();
  for (const node of nodes) {
    const root = find(node.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(node);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** Places each cluster on a sunflower spiral so distinct clusters don't start overlapping, colors them, and seeds node positions/anchors within their cluster. Anchors are gentle attractors the simulation pulls toward, keeping clusters visually distinct instead of collapsing into one blob. */
export function layoutGraphClusters(nodes, edges) {
  const clusters = computeGraphClusters(nodes, edges);
  clusters.forEach((cluster, index) => {
    const color = cluster.length > 1 ? CLUSTER_COLORS[index % CLUSTER_COLORS.length] : SOLO_NODE_COLOR;
    const spread = 26 * Math.sqrt(index);
    const angle = index * GRAPH_GOLDEN_ANGLE;
    const anchorX = index === 0 ? 0 : Math.cos(angle) * spread;
    const anchorY = index === 0 ? 0 : Math.sin(angle) * spread;
    cluster.forEach((node, i) => {
      const localAngle = (i / Math.max(cluster.length, 1)) * Math.PI * 2;
      const localRadius = cluster.length > 1 ? 14 + Math.sqrt(cluster.length) * 8 : 0;
      node.anchorX = anchorX + Math.cos(localAngle) * localRadius;
      node.anchorY = anchorY + Math.sin(localAngle) * localRadius;
      node.x = node.anchorX + (Math.random() - 0.5) * 8;
      node.y = node.anchorY + (Math.random() - 0.5) * 8;
      node.vx = 0; node.vy = 0;
      node.clusterColor = color;
      node.labelColor = lightenHexColor(color, 0.55);
      node.clusterSize = cluster.length;
    });
  });
}

/**
 * Lays out the nodes and resolves the edges to direct node references once, so nothing per frame has
 * to search by id. Edges whose endpoint is missing (a memory linking to a deleted one) are dropped.
 * `colorGroups` buckets nodes by color so drawing can fill each color in a single path.
 */
export function createGraph(data) {
  const nodes = data.nodes;
  layoutGraphClusters(nodes, data.edges);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = [];
  for (const edge of data.edges) {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (source && target) links.push({ source, target });
  }
  const colorGroups = new Map();
  for (const node of nodes) {
    const color = node.clusterColor || SOLO_NODE_COLOR;
    if (!colorGroups.has(color)) colorGroups.set(color, []);
    colorGroups.get(color).push(node);
  }
  return { nodes, links, colorGroups, alpha: 1 };
}

/** Raises the simulation temperature so it moves again, e.g. after a node is dragged. */
export function reheatGraph(graph, alpha = 1) {
  graph.alpha = Math.max(graph.alpha, alpha);
}

export function isGraphSettled(graph) {
  return graph.alpha < GRAPH_ALPHA_MIN;
}

// --- Barnes-Hut quadtree ---------------------------------------------------------------------

function makeCell(x, y, size) {
  return { x, y, size, mass: 0, cx: 0, cy: 0, bodies: null, kids: null };
}

function childFor(cell, body) {
  const half = cell.size / 2;
  const qx = body.x >= cell.x + half ? 1 : 0;
  const qy = body.y >= cell.y + half ? 1 : 0;
  const index = qy * 2 + qx;
  if (cell.kids[index] === null) cell.kids[index] = makeCell(cell.x + qx * half, cell.y + qy * half, half);
  return cell.kids[index];
}

function insertBody(root, body, startDepth = 0) {
  let cell = root;
  let depth = startDepth;
  for (;;) {
    if (cell.mass === 0) {
      cell.bodies = [body];
      cell.mass = 1;
      cell.cx = body.x;
      cell.cy = body.y;
      return;
    }
    const mass = cell.mass;
    cell.cx = (cell.cx * mass + body.x) / (mass + 1);
    cell.cy = (cell.cy * mass + body.y) / (mass + 1);
    cell.mass = mass + 1;
    if (cell.kids === null) {
      if (depth >= GRAPH_TREE_MAX_DEPTH) { cell.bodies.push(body); return; }
      // Occupied leaf: split it, pushing the bodies it already held one level down.
      const existing = cell.bodies;
      cell.bodies = null;
      cell.kids = [null, null, null, null];
      for (const other of existing) insertBody(childFor(cell, other), other, depth + 1);
    }
    cell = childFor(cell, body);
    depth++;
  }
}

/** Builds a quadtree over all nodes. The root is a square just large enough to hold every node. */
export function buildQuadtree(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }
  if (!Number.isFinite(minX)) return makeCell(0, 0, 1);
  const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
  const root = makeCell(minX, minY, size);
  for (const node of nodes) insertBody(root, node);
  return root;
}

/** Repulsive force on `node` from every other node, treating far-away cells as single heavier bodies. */
export function repulsionOn(tree, node) {
  let fx = 0, fy = 0;
  const stack = [tree];
  while (stack.length > 0) {
    const cell = stack.pop();
    if (cell.mass === 0) continue;
    if (cell.kids === null) {
      for (const other of cell.bodies) {
        if (other === node) continue;
        const dx = node.x - other.x, dy = node.y - other.y;
        const distSq = Math.max(dx * dx + dy * dy, 25);
        const force = GRAPH_REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        fx += (dx / dist) * force; fy += (dy / dist) * force;
      }
      continue;
    }
    const dx = node.x - cell.cx, dy = node.y - cell.cy;
    const rawDistSq = dx * dx + dy * dy;
    const containsNode = node.x >= cell.x && node.x < cell.x + cell.size && node.y >= cell.y && node.y < cell.y + cell.size;
    if (!containsNode && cell.size * cell.size < GRAPH_THETA * GRAPH_THETA * rawDistSq) {
      const distSq = Math.max(rawDistSq, 25);
      const force = (GRAPH_REPULSION * cell.mass) / distSq;
      const dist = Math.sqrt(distSq);
      fx += (dx / dist) * force; fy += (dy / dist) * force;
      continue;
    }
    for (const kid of cell.kids) if (kid !== null) stack.push(kid);
  }
  return [fx, fy];
}

/** One simulation step. Forces are scaled by the graph's alpha, which then decays toward settling. */
export function stepGraphSimulation(graph) {
  const { nodes, links } = graph;
  const alpha = graph.alpha;
  const tree = buildQuadtree(nodes);
  for (const node of nodes) {
    if (node.pinned) continue;
    const [fx, fy] = repulsionOn(tree, node);
    node._fx = fx; node._fy = fy;
  }
  for (const { source, target } of links) {
    const dx = target.x - source.x, dy = target.y - source.y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const stretch = dist - GRAPH_SPRING_LENGTH;
    const force = stretch * GRAPH_SPRING_STRENGTH;
    const fx = (dx / dist) * force, fy = (dy / dist) * force;
    if (!source.pinned) { source._fx += fx; source._fy += fy; }
    if (!target.pinned) { target._fx -= fx; target._fy -= fy; }
  }
  for (const node of nodes) {
    if (node.pinned) continue;
    node._fx += (node.anchorX - node.x) * GRAPH_ANCHOR_STRENGTH;
    node._fy += (node.anchorY - node.y) * GRAPH_ANCHOR_STRENGTH;
    let vx = (node.vx + node._fx * alpha) * GRAPH_DAMPING;
    let vy = (node.vy + node._fy * alpha) * GRAPH_DAMPING;
    // Repulsion is inverse-square and nodes can seed close together, so the first few
    // frames can spike velocity into the hundreds; clamp speed so energy bleeds off
    // smoothly instead of launching nodes across the canvas.
    const speed = Math.hypot(vx, vy);
    if (speed > GRAPH_MAX_SPEED) { vx = (vx / speed) * GRAPH_MAX_SPEED; vy = (vy / speed) * GRAPH_MAX_SPEED; }
    node.vx = vx; node.vy = vy;
    node.x += node.vx; node.y += node.vy;
  }
  graph.alpha = alpha * GRAPH_ALPHA_DECAY;
}

(function (global) {
  'use strict';

  const R = 6371008.8;
  const RAD = Math.PI / 180;
  const EPS = 1e-7;
  const denied = new Set(['no', 'use_sidepath']);
  const privateValues = new Set(['private', 'permit']);
  const nonDriving = new Set(['footway', 'pedestrian', 'steps', 'cycleway', 'bridleway', 'corridor', 'platform', 'construction', 'proposed', 'raceway']);
  const unpavedValues = new Set(['unpaved', 'gravel', 'fine_gravel', 'ground', 'dirt', 'earth', 'sand', 'mud', 'grass', 'compacted', 'pebblestone']);
  const tag = (edge, key) => String(edge[key] ?? edge.tags?.[key] ?? '').trim().toLowerCase();
  const lngDelta = value => value >= -180 && value <= 180 ? value : ((value + 540) % 360) - 180;
  const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
  const failure = (code, error) => ({ error, code });

  class MinHeap {
    constructor() { this.items = []; }
    push(value) {
      const list = this.items;
      let index = list.length;
      list.push(value);
      while (index) {
        const parent = (index - 1) >> 1;
        if (list[parent].priority <= value.priority) break;
        list[index] = list[parent]; index = parent;
      }
      list[index] = value;
    }
    pop() {
      const list = this.items;
      if (!list.length) return null;
      const result = list[0], last = list.pop();
      if (!list.length) return result;
      let index = 0;
      while (index * 2 + 1 < list.length) {
        let child = index * 2 + 1;
        if (child + 1 < list.length && list[child + 1].priority < list[child].priority) child++;
        if (list[child].priority >= last.priority) break;
        list[index] = list[child]; index = child;
      }
      list[index] = last;
      return result;
    }
    get size() { return this.items.length; }
  }

  class LocalRouter {
    constructor(network, options = {}) {
      if (!network || !Array.isArray(network.nodes) || !Array.isArray(network.edges)) throw new TypeError('Некорректный файл дорожной сети');
      this.geographic = options.geographic ?? options.geo ?? (network.coordinateSystem !== 'scheme-pixels');
      this.network = network;
      this.nodes = new Map();
      this.edges = [];
      this.diagnostics = { skippedNodes: 0, skippedEdges: 0 };
      this.defaults = { allowPrivate: false, allowTrack: true, maxSnapMeters: 500, maxSnapDistance: 80, ...options };
      this._cache = new Map();
      for (const node of network.nodes) {
        const id = Array.isArray(node) ? node[0] : node.id;
        const point = Array.isArray(node) ? this._point(node.slice(1, 3)) : this._point(node);
        if (id == null || !point) { this.diagnostics.skippedNodes++; continue; }
        this.nodes.set(String(id), point);
      }
      network.edges.forEach((source, index) => {
        const from = String(source.from), to = String(source.to);
        if (!this.nodes.has(from) || !this.nodes.has(to)) { this.diagnostics.skippedEdges++; return; }
        const supplied = source.coordinates;
        const coordinates = Array.isArray(supplied) && supplied.length >= 2 ? supplied.map(point => this._point(point)) : [this.nodes.get(from), this.nodes.get(to)];
        if (coordinates.some(point => !point)) { this.diagnostics.skippedEdges++; return; }
        const edge = this._edge(source, String(source.id ?? index), from, to, coordinates);
        if (!edge) { this.diagnostics.skippedEdges++; return; }
        const directed = network.directed === true;
        if (directed) { this.edges.push(edge); return; }
        const direction = tag(source, 'oneway');
        const reverseOnly = direction === '-1' || direction === 'reverse';
        const forwardOnly = ['true', '1', 'yes'].includes(direction) || (!direction && tag(source, 'junction') === 'roundabout');
        if (!reverseOnly) this.edges.push(edge);
        if (!forwardOnly) this.edges.push(this._edge(source, edge.id, to, from, [...coordinates].reverse()));
      });
      this.edges.forEach((edge, index) => { edge.stateId = index; });
      this.turnRules = new Map();
      this.diagnostics.parsedTurnRestrictions = 0;
      this.diagnostics.skippedTurnRestrictions = 0;
      if (this.geographic) for (const rule of network.turnRestrictions ?? network.metadata?.turnRestrictions ?? []) {
        const members = Array.isArray(rule.members) ? rule.members : [];
        const type = String(rule.restriction ?? rule.tags?.restriction ?? '').trim().toLowerCase();
        const via = rule.viaNodeId ?? rule.viaNode ?? rule.via ?? members.find(member => member.role === 'via' && member.type === 'node')?.ref;
        const from = rule.fromWayId ?? rule.fromWay ?? rule.from ?? members.find(member => member.role === 'from' && member.type === 'way')?.ref;
        const to = rule.toWayId ?? rule.toWay ?? rule.to ?? members.find(member => member.role === 'to' && member.type === 'way')?.ref;
        const exceptions = String(rule.except ?? rule.tags?.except ?? '').toLowerCase().split(/[;,\s]+/);
        if (exceptions.some(value => ['motorcar', 'motor_vehicle', 'vehicle'].includes(value))) continue;
        if (via == null || from == null || to == null || !/^(only|no)_/.test(type) || !this.nodes.has(String(via))) { this.diagnostics.skippedTurnRestrictions++; continue; }
        const key = String(via);
        if (!this.turnRules.has(key)) this.turnRules.set(key, new Map());
        const incoming = this.turnRules.get(key);
        if (!incoming.has(String(from))) incoming.set(String(from), []);
        incoming.get(String(from)).push({ type, to: String(to), source: rule });
        this.diagnostics.parsedTurnRestrictions++;
      }
    }

    static async load(url, options = {}) {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Не удалось загрузить дорожную сеть');
      return new LocalRouter(await response.json(), options);
    }

    _point(value) {
      const point = Array.isArray(value) ? [value[0], value[1]] : this.geographic ? [value?.lat, value?.lng ?? value?.lon] : [value?.x, value?.y];
      if (!point.every(number => typeof number === 'number' && Number.isFinite(number))) return null;
      if (this.geographic && (Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180)) return null;
      return point;
    }

    _distance(a, b) {
      if (!this.geographic) return Math.hypot(a[0] - b[0], a[1] - b[1]);
      const lat = (b[0] - a[0]) * RAD, lng = lngDelta(b[1] - a[1]) * RAD;
      const h = Math.sin(lat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(lng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
    }

    _edge(source, id, from, to, coordinates) {
      const cumulative = [0];
      for (let index = 1; index < coordinates.length; index++) cumulative.push(cumulative[index - 1] + this._distance(coordinates[index - 1], coordinates[index]));
      const length = cumulative[cumulative.length - 1];
      if (length <= EPS) return null;
      const physicalKey = String(source.segmentId ?? source.segmentKey ?? source.segmentsKey ?? [from, to].sort().join('|'));
      return { id, from, to, coordinates, cumulative, length, source, physicalKey };
    }

    _allowed(edge, options) {
      if (!this.geographic) return true;
      const source = edge.source;
      const permissions = ['access', 'vehicle', 'motor_vehicle', 'motorcar'].map(key => tag(source, key));
      if (permissions.some(value => denied.has(value))) return false;
      if ((source.restricted || permissions.some(value => privateValues.has(value))) && !options.allowPrivate) return false;
      const highway = tag(source, 'highway');
      if ((source.track || highway === 'track') && !options.allowTrack) return false;
      if (nonDriving.has(highway)) return false;
      if (highway === 'path' && (!options.allowTrack || !['yes', 'designated', 'permissive'].includes(tag(source, 'motor_vehicle')))) return false;
      return true;
    }

    _wayId(edge) {
      return edge == null ? null : String(edge.source.osmWayId ?? edge.source.wayId ?? edge.source.id ?? edge.id);
    }

    _turnAllowed(incoming, outgoing, node) {
      if (!this.geographic || !incoming || !outgoing) return true;
      const rules = this.turnRules.get(String(node))?.get(this._wayId(incoming));
      if (!rules?.length) return true;
      const nextWay = this._wayId(outgoing), previousWay = this._wayId(incoming);
      const reverse = incoming.from === outgoing.to && incoming.physicalKey === outgoing.physicalKey;
      const matches = rule => {
        if (rule.to !== nextWay) return false;
        if (rule.to !== previousWay) return true;
        if (rule.type === 'no_u_turn' || rule.type === 'only_u_turn') return reverse;
        if (rule.type === 'no_straight_on' || rule.type.startsWith('only_')) return !reverse;
        return true;
      };
      if (rules.some(rule => rule.type.startsWith('no_') && matches(rule))) return false;
      const only = rules.filter(rule => rule.type.startsWith('only_'));
      return !only.length || only.some(matches);
    }

    _view(options) {
      const key = `${Boolean(options.allowPrivate)}:${Boolean(options.allowTrack)}`;
      if (this._cache.has(key)) return this._cache.get(key);
      const adjacency = new Map(), physical = new Map();
      for (const edge of this.edges) {
        if (!this._allowed(edge, options)) continue;
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
        adjacency.get(edge.from).push(edge);
        if (!physical.has(edge.physicalKey)) physical.set(edge.physicalKey, []);
        physical.get(edge.physicalKey).push(edge);
      }
      const view = { adjacency, physical };
      this._cache.set(key, view);
      return view;
    }

    _project(point, edge) {
      let best = null;
      for (let index = 0; index + 1 < edge.coordinates.length; index++) {
        const a = edge.coordinates[index], b = edge.coordinates[index + 1];
        let ax, ay, bx, by;
        if (this.geographic) {
          const scale = Math.max(1e-8, Math.cos(point[0] * RAD));
          ax = lngDelta(a[1] - point[1]) * scale; ay = a[0] - point[0];
          bx = lngDelta(b[1] - point[1]) * scale; by = b[0] - point[0];
        } else {
          ax = a[0] - point[0]; ay = a[1] - point[1];
          bx = b[0] - point[0]; by = b[1] - point[1];
        }
        const dx = bx - ax, dy = by - ay, denominator = dx * dx + dy * dy;
        const t = denominator ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator)) : 0;
        const projected = t === 0 ? [...a] : t === 1 ? [...b] : this.geographic ? [a[0] + (b[0] - a[0]) * t, a[1] + lngDelta(b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const distance = this._distance(point, projected);
        if (!best || distance < best.distance) best = { point: projected, distance, segmentIndex: index, t, along: edge.cumulative[index] + (edge.cumulative[index + 1] - edge.cumulative[index]) * t, edge };
      }
      return best;
    }

    _snap(point, view) {
      let best = null, group = null;
      for (const edges of view.physical.values()) {
        const snap = this._project(point, edges[0]);
        if (!best || snap.distance < best.distance) { best = snap; group = edges; }
      }
      if (!best) return null;
      const candidates = group.map(edge => this._project(point, edge)).filter(snap => this._distance(snap.point, best.point) < (this.geographic ? .05 : .001));
      return { ...best, candidates };
    }

    _endpoint(edge, end) {
      return end ? { point: edge.coordinates[edge.coordinates.length - 1], segmentIndex: edge.coordinates.length - 2, t: 1, along: edge.length, edge } : { point: edge.coordinates[0], segmentIndex: 0, t: 0, along: 0, edge };
    }

    _slice(edge, start, end) {
      const result = [start.point];
      for (let index = start.segmentIndex + 1; index <= end.segmentIndex; index++) if (!samePoint(result[result.length - 1], edge.coordinates[index])) result.push(edge.coordinates[index]);
      if (!samePoint(result[result.length - 1], end.point)) result.push(end.point);
      return result;
    }

    _connectors(snap, starting) {
      const result = new Map();
      const add = (node, distance, coordinates, edge) => {
        const key = `${node}\u0000${distance > EPS ? edge.stateId : '-'}`;
        if (!result.has(key) || distance < result.get(key).distance) result.set(key, { node, distance, coordinates, edges: distance > EPS ? [edge] : [] });
      };
      for (const candidate of snap.candidates) {
        const edge = candidate.edge;
        if (starting) add(edge.to, Math.max(0, edge.length - candidate.along), this._slice(edge, candidate, this._endpoint(edge, true)), edge);
        else add(edge.from, Math.max(0, candidate.along), this._slice(edge, this._endpoint(edge, false), candidate), edge);
        if (candidate.along <= EPS) add(edge.from, 0, [candidate.point], edge);
        if (edge.length - candidate.along <= EPS) add(edge.to, 0, [candidate.point], edge);
      }
      return [...result.values()];
    }

    path(start, destination, options = {}) { return this.route(start, destination, options); }

    route(startValue, destinationValue, options = {}) {
      const start = this._point(startValue), destination = this._point(destinationValue);
      if (!start || !destination) return failure('INVALID_COORDINATES', this.geographic ? 'Не удалось определить координаты начала или конца маршрута' : 'Не удалось определить точки на схеме');
      const settings = { ...this.defaults, ...options };
      const maximumSnap = this.geographic ? (options.maxSnapDistance ?? settings.maxSnapMeters) : settings.maxSnapDistance;
      if (!Number.isFinite(maximumSnap) || maximumSnap < 0) return failure('INVALID_SNAP_LIMIT', 'Некорректное расстояние поиска дороги');
      const view = this._view(settings);
      const startSnap = this._snap(start, view), endSnap = this._snap(destination, view);
      if (!startSnap || startSnap.distance > maximumSnap) return failure('NO_ROAD_NEAR_START', 'Рядом с начальной точкой нет доступной дороги в сохранённой сети');
      if (!endSnap || endSnap.distance > maximumSnap) return failure('NO_ROAD_NEAR_END', 'Рядом с конечной точкой нет доступной дороги в сохранённой сети');
      const starts = this._connectors(startSnap, true), ends = this._connectors(endSnap, false);
      const endsByNode = new Map();
      for (const ending of ends) {
        if (!endsByNode.has(ending.node)) endsByNode.set(ending.node, []);
        endsByNode.get(ending.node).push(ending);
      }
      let bestDistance = Infinity, best = null;
      for (const from of startSnap.candidates) for (const to of endSnap.candidates) {
        if (from.edge !== to.edge || from.along > to.along + EPS) continue;
        const distance = Math.max(0, to.along - from.along);
        if (distance < bestDistance) { bestDistance = distance; best = { direct: { distance, coordinates: this._slice(from.edge, from, to), edges: distance > EPS ? [from.edge] : [] } }; }
      }
      const heap = new MinHeap(), distances = new Map(), previous = new Map();
      const stateKey = (node, incoming) => `${node}\u0000${incoming?.stateId ?? '-'}`;
      for (const connector of starts) {
        const node = connector.node, incoming = connector.edges.at(-1) ?? null, state = stateKey(node, incoming);
        if (distances.has(state) && distances.get(state) <= connector.distance) continue;
        distances.set(state, connector.distance); previous.set(state, { previous: null, part: connector });
        heap.push({ state, node, incoming, distance: connector.distance, priority: connector.distance + this._distance(this.nodes.get(node), endSnap.point) });
      }
      while (heap.size) {
        const current = heap.pop();
        if (current.distance !== distances.get(current.state)) continue;
        if (current.priority >= bestDistance - EPS) break;
        for (const ending of endsByNode.get(current.node) ?? []) {
          if (!this._turnAllowed(current.incoming, ending.edges[0] ?? null, current.node)) continue;
          if (current.distance + ending.distance < bestDistance) { bestDistance = current.distance + ending.distance; best = { state: current.state, ending }; }
        }
        for (const edge of view.adjacency.get(current.node) || []) {
          if (!this._turnAllowed(current.incoming, edge, current.node)) continue;
          const nextDistance = current.distance + edge.length;
          const nextState = stateKey(edge.to, edge);
          if (nextDistance >= (distances.get(nextState) ?? Infinity) - EPS) continue;
          distances.set(nextState, nextDistance); previous.set(nextState, { previous: current.state, part: { distance: edge.length, coordinates: edge.coordinates, edges: [edge] } });
          heap.push({ state: nextState, node: edge.to, incoming: edge, distance: nextDistance, priority: nextDistance + this._distance(this.nodes.get(edge.to), endSnap.point) });
        }
      }
      if (!best) return failure('NO_ROUTE', 'Между точками нет связного проезда по доступным дорогам сохранённой сети');
      let parts;
      if (best.direct) parts = [best.direct];
      else {
        parts = [best.ending];
        let state = best.state;
        while (state != null) { const step = previous.get(state); parts.push(step.part); state = step.previous; }
        parts.reverse();
      }
      const coordinates = [], traversed = [], edgeIds = [];
      for (const part of parts) {
        for (const point of part.coordinates) if (!coordinates.length || !samePoint(coordinates[coordinates.length - 1], point)) coordinates.push([...point]);
        for (const edge of part.edges) { traversed.push(edge); if (edgeIds[edgeIds.length - 1] !== edge.id) edgeIds.push(edge.id); }
      }
      if (coordinates.length === 1) coordinates.push([...coordinates[0]]);
      const flags = [];
      if (this.geographic) {
        if (traversed.some(edge => edge.source.restricted || ['access', 'vehicle', 'motor_vehicle', 'motorcar'].some(key => privateValues.has(tag(edge.source, key))))) flags.push('private');
        if (traversed.some(edge => edge.source.track || tag(edge.source, 'highway') === 'track')) flags.push('track');
        if (traversed.some(edge => unpavedValues.has(tag(edge.source, 'surface')))) flags.push('unpaved');
        if (traversed.some(edge => edge.source.gate)) flags.push('gate');
        if (traversed.some(edge => ['access:conditional', 'vehicle:conditional', 'motor_vehicle:conditional', 'motorcar:conditional'].some(key => tag(edge.source, key)))) flags.push('conditional-access');
        if (startSnap.distance > 2 || endSnap.distance > 2) flags.push('offroad-connectors');
      }
      const result = { coordinates, edgeIds, flags, distanceUnits: this.geographic ? 'm' : 'px', snaps: { start: [...startSnap.point], end: [...endSnap.point] } };
      if (this.geographic) Object.assign(result, { distanceMeters: bestDistance, accessDistanceMeters: startSnap.distance + endSnap.distance, snaps: { ...result.snaps, startMeters: startSnap.distance, endMeters: endSnap.distance } });
      else Object.assign(result, { distancePixels: bestDistance, snaps: { ...result.snaps, startPixels: startSnap.distance, endPixels: endSnap.distance } });
      return result;
    }
  }

  global.LocalRouter = LocalRouter;
  if (typeof module !== 'undefined' && module.exports) module.exports = LocalRouter;
}(typeof window !== 'undefined' ? window : globalThis));

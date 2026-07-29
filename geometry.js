// ===================================================================================
// geometry.js — pole contraction (fullerene -> Catalan-like C(n)) and its inverse,
// plus the canonical-form polish used to touch up the reconstructed fullerene view.
// C(n) itself is loaded pre-solved from catalan_data.js, not built or canonicalized
// here — the values that data was solved for. This module only handles the topology
// bridge between C(n) and its underlying fullerene.
//
// A "Poly" is {verts: THREE.Vector3[], faces: number[][]} where each face is a CCW
// (outward-facing) list of vertex indices.
// ===================================================================================
(function (global) {
  'use strict';

  // Contract each pole face (a pentagon for icosahedral symmetry, a quad for octahedral,
  // a triangle for tetrahedral) of
  // a fullerene-like trivalent polyhedron to its centroid pole, producing C(n). Each pole face
  // always gets its own pole, even under non-IPR adjacency — a vertex shared by two pole faces
  // (an edge where they touch) is assigned to whichever claims it first; which one doesn't
  // matter topologically, since either choice yields the same face-size distribution and
  // pole-degree pattern (verified against a hand-solved icosahedral example). The pole face(s)
  // on the losing side of that assignment simply end up with a pole of degree (poleDegree - 1)
  // instead of poleDegree — the ordinary corner-collapsing below accounts for the "lost" wedge
  // on its own, with no special-casing needed. An isolated hexagon (touching no pole face at
  // all) likewise survives unchanged as a 6-sided face rather than erroring.
  function poleContract(fullerene, opts) {
    const poleDegree = (opts && opts.poleDegree) || 5;
    const expectedPoleCount = (opts && opts.expectedPoleCount) || 12;
    const nv = fullerene.verts.length;
    const poleFaces = [];
    for (let fi = 0; fi < fullerene.faces.length; fi++) if (fullerene.faces[fi].length === poleDegree) poleFaces.push(fi);
    if (poleFaces.length !== expectedPoleCount) return { ok: false, msg: `expected ${expectedPoleCount} ${poleDegree}-gons, found ${poleFaces.length}` };

    const vertexPole = new Array(nv).fill(-1);
    for (const fi of poleFaces) {
      for (const v of fullerene.faces[fi]) {
        if (vertexPole[v] === -1) vertexPole[v] = fi;
      }
    }

    const poleId = new Map(), keepId = new Map();
    const newVerts = [];
    for (const fi of poleFaces) {
      const sum = new THREE.Vector3();
      for (const v of fullerene.faces[fi]) sum.add(fullerene.verts[v]);
      poleId.set(fi, newVerts.length);
      newVerts.push(sum.multiplyScalar(1 / poleDegree).normalize());
    }
    for (let v = 0; v < nv; v++) if (vertexPole[v] === -1) { keepId.set(v, newVerts.length); newVerts.push(fullerene.verts[v].clone()); }
    const mapVert = v => vertexPole[v] !== -1 ? poleId.get(vertexPole[v]) : keepId.get(v);

    const newFaces = [];
    for (let fi = 0; fi < fullerene.faces.length; fi++) {
      if (fullerene.faces[fi].length === poleDegree) continue;
      const mapped = fullerene.faces[fi].map(mapVert);
      const collapsed = [];
      for (const v of mapped) if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== v) collapsed.push(v);
      if (collapsed.length > 1 && collapsed[0] === collapsed[collapsed.length - 1]) collapsed.pop();
      newFaces.push(collapsed);
    }

    // Non-isolated-pole-face edges: the fullerene edges directly shared by two pole faces.
    // Each such edge is what gets highlighted in the fullerene view as the visible defect.
    const poleEdgeOwner = new Map();
    const nonIsolatedPentagonEdges = [];
    for (const fi of poleFaces) {
      const f = fullerene.faces[fi];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (poleEdgeOwner.has(key)) nonIsolatedPentagonEdges.push([a, b]);
        else poleEdgeOwner.set(key, fi);
      }
    }
    const nonIsolatedPentagonPairs = nonIsolatedPentagonEdges.length;

    const poly = { verts: newVerts, faces: newFaces };
    const counts = { a3: 0, a4: 0, a5: 0, other: 0 };
    for (const f of newFaces) {
      if (f.length === 3) counts.a3++; else if (f.length === 4) counts.a4++; else if (f.length === 5) counts.a5++; else counts.other++;
    }
    // A face of size other than 3/4/5 after contraction means an isolated (p=0) hexagon
    // survived — true regardless of poleDegree, since a collapsed pole-adjacent face is always
    // smaller than its original hexagon (max hexagon shrink is to a triangle).
    const isolatedHexagonCount = counts.other;
    const admissible = isolatedHexagonCount === 0 && nonIsolatedPentagonPairs === 0;
    const mapping = new Array(nv);
    for (let v = 0; v < nv; v++) mapping[v] = mapVert(v);

    // Poles whose final degree isn't poleDegree are exactly the ones that lost a wedge to a
    // pole-face-adjacency edge — useful for flagging the defect faces around them.
    const finalPoleDegree = new Array(poleFaces.length).fill(0);
    for (const f of newFaces) for (const v of f) if (v < poleFaces.length) finalPoleDegree[v]++;
    const anomalousPoles = finalPoleDegree.reduce((s, d, i) => (d !== poleDegree ? s.concat(i) : s), []);

    return {
      ok: true, poly, poleCount: poleFaces.length, keptCount: keepId.size, counts, admissible, mapping,
      isolatedHexagonCount, nonIsolatedPentagonPairs, nonIsolatedPentagonEdges, anomalousPoles
    };
  }

  // Reverse of poleContract: given C(n) (with `expectedPoleCount` degree-`poleDegree` poles),
  // reconstruct a fullerene by expanding each pole into a poleDegree-gon of poleDegree new
  // vertices. For a pole P touching faces in cyclic order F_0..F_{d-1} (F_w between
  // neighbours[w] and neighbours[w+1]), F_w gets P replaced by (p_w, p_{w+1}) — this is
  // exactly the inverse of the collapse used above, and produces a topologically valid
  // fullerene (checked before returning).
  function poleExpand(poly, opts) {
    const poleDegree = (opts && opts.poleDegree) || 5;
    const expectedPoleCount = (opts && opts.expectedPoleCount) || 12;
    const nv = poly.verts.length;
    // A degree scan can't identify poles when poleDegree is 3 (tetrahedral symmetry):
    // "kept" vertices are always degree 3 too (the source fullerene is trivalent
    // throughout), so it would find every vertex, not just the true poles. opts.poles
    // (an entry's explicit pole-index list, present exactly when this applies) is used
    // instead when given.
    let poles;
    if (opts && opts.poles) {
      poles = opts.poles.slice();
    } else {
      const degree = new Array(nv).fill(0);
      for (const f of poly.faces) for (const v of f) degree[v]++;
      poles = [];
      for (let v = 0; v < nv; v++) if (degree[v] === poleDegree) poles.push(v);
    }
    if (poles.length !== expectedPoleCount) return { ok: false, msg: `expected ${expectedPoleCount} degree-${poleDegree} vertices, found ${poles.length}` };
    const poleSet = new Set(poles);

    const poleData = new Map();
    for (const P of poles) {
      const recs = [];
      for (let fi = 0; fi < poly.faces.length; fi++) {
        const f = poly.faces[fi];
        const idx = f.indexOf(P);
        if (idx < 0) continue;
        const n = f.length;
        recs.push([f[(idx - 1 + n) % n], f[(idx + 1) % n], fi]);
      }
      if (recs.length !== poleDegree) return { ok: false, msg: `pole ${P} touches ${recs.length} faces, expected ${poleDegree}` };
      const map = new Map();
      for (const r of recs) map.set(r[0], [r[1], r[2]]);
      const start = recs[0][0];
      const neighbors = [start];
      const faceSeq = [];
      let cur = start;
      for (let step = 0; step < poleDegree; step++) {
        const [nxt, fi] = map.get(cur);
        faceSeq.push(fi);
        if (step < poleDegree - 1) neighbors.push(nxt);
        cur = nxt;
      }
      poleData.set(P, { neighbors, faceSeq });
    }

    const newVerts = [];
    const keepId = new Map();
    for (let v = 0; v < nv; v++) if (!poleSet.has(v)) { keepId.set(v, newVerts.length); newVerts.push(poly.verts[v].clone()); }
    const poleNewIds = new Map();
    for (const P of poles) {
      const pd = poleData.get(P);
      const ids = [];
      // seed each of the poleDegree new vertices distinctly (nudged toward its own external
      // neighbour) rather than all coincident at the pole's position — a degenerate coincident
      // start gives the canonicalize polish nothing to work with.
      for (let i = 0; i < poleDegree; i++) {
        ids.push(newVerts.length);
        const nb = poly.verts[pd.neighbors[i]];
        newVerts.push(poly.verts[P].clone().lerp(nb, 0.35).normalize());
      }
      poleNewIds.set(P, ids);
    }
    // wedge lookup: for pole P and face fi, which wedge index (0..poleDegree-1) is this occurrence
    const wedgeOf = new Map(); // "P_fi" -> j
    for (const P of poles) {
      const pd = poleData.get(P);
      for (let j = 0; j < poleDegree; j++) wedgeOf.set(P + '_' + pd.faceSeq[j], j);
    }

    const rebuilt = [];
    for (let fi = 0; fi < poly.faces.length; fi++) {
      const f = poly.faces[fi];
      const out = [];
      for (let i = 0; i < f.length; i++) {
        const v = f[i];
        if (!poleSet.has(v)) { out.push(keepId.get(v)); continue; }
        const j = wedgeOf.get(v + '_' + fi);
        const ids = poleNewIds.get(v);
        out.push(ids[j], ids[(j + 1) % poleDegree]);
      }
      rebuilt.push(out);
    }
    for (const P of poles) rebuilt.push(poleNewIds.get(P).slice());

    const fullerene = { verts: newVerts, faces: rebuilt };
    const check = validateFullereneTopology(fullerene, newVerts.length, { poleDegree, expectedPoleCount });
    return { ok: check.ok, fullerene, msg: check.ok ? 'ok' : 'expanded topology failed validation', keepId, poleNewIds, poles };
  }

  // Ensure every face is wound consistently with its neighbours (a proper orientable manifold
  // has each undirected edge appear as (a,b) in exactly one face and (b,a) in the other). BFS
  // over face-adjacency from face 0, flipping any face found wound the wrong way relative to
  // its already-fixed neighbour.
  function fixOrientationConsistency(poly) {
    const faces = poly.faces;
    const nf = faces.length;
    const undirected = new Map();
    const addU = (a, b, fi) => {
      const key = Math.min(a, b) + '_' + Math.max(a, b);
      if (!undirected.has(key)) undirected.set(key, []);
      undirected.get(key).push(fi);
    };
    for (let fi = 0; fi < nf; fi++) {
      const f = faces[fi];
      for (let i = 0; i < f.length; i++) addU(f[i], f[(i + 1) % f.length], fi);
    }
    const hasDirectedEdge = (fi, a, b) => {
      const f = faces[fi];
      for (let i = 0; i < f.length; i++) if (f[i] === a && f[(i + 1) % f.length] === b) return true;
      return false;
    };

    const visited = new Array(nf).fill(false);
    let flips = 0;
    for (let start = 0; start < nf; start++) {
      if (visited[start]) continue;
      visited[start] = true;
      const queue = [start];
      while (queue.length) {
        const fi = queue.shift();
        const f = faces[fi];
        const n = f.length;
        for (let i = 0; i < n; i++) {
          const a = f[i], b = f[(i + 1) % n];
          const key = Math.min(a, b) + '_' + Math.max(a, b);
          const touching = undirected.get(key) || [];
          const fj = touching.find(x => x !== fi);
          if (fj === undefined || visited[fj]) continue;
          if (hasDirectedEdge(fj, a, b)) { faces[fj].reverse(); flips++; }
          visited[fj] = true;
          queue.push(fj);
        }
      }
    }
    return flips;
  }

  // Spherical spring relaxation: cheap seed embedding, used only for the reconstructed
  // fullerene view (C(n) itself is loaded pre-solved, never relaxed). Pure neighbour
  // averaging + renormalizing is a consensus process — run to full convergence it
  // collapses EVERY vertex onto a single point, not just onto a smoother layout. How
  // many iterations that takes depends on the graph's mixing rate, which varies a lot,
  // so instead of trusting the iteration budget, detect incipient collapse directly:
  // if the mean of the (unit-vector) candidate positions has grown large, the vertices
  // are converging onto a common direction — stop before applying that step.
  function sphereRelax(poly, iterations) {
    const verts = poly.verts, faces = poly.faces;
    const nv = verts.length;
    const neighbors = new Array(nv).fill(null).map(() => []);
    const seen = new Set();
    for (const f of faces) {
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        neighbors[a].push(b); neighbors[b].push(a);
      }
    }
    for (let iter = 0; iter < iterations; iter++) {
      const next = new Array(nv);
      for (let v = 0; v < nv; v++) {
        const nbs = neighbors[v];
        const sum = new THREE.Vector3();
        for (const u of nbs) sum.add(verts[u]);
        next[v] = nbs.length > 0 ? sum.multiplyScalar(1 / nbs.length).normalize() : verts[v].clone();
      }
      const mean = new THREE.Vector3();
      for (const v of next) mean.add(v);
      mean.multiplyScalar(1 / nv);
      if (mean.length() > 0.9) break;
      for (let v = 0; v < nv; v++) verts[v] = next[v];
    }
  }

  // Project every vertex onto its own best-fit face plane (Newell's-method normal),
  // averaged across all faces sharing that vertex. Shared by canonicalize's own
  // midsphere iteration and by relax()'s per-iteration face-flattening pass.
  function planarizeStep(poly) {
    const verts = poly.verts, faces = poly.faces;
    const nv = verts.length;
    const accum = new Array(nv), cnt = new Array(nv).fill(0);
    for (let i = 0; i < nv; i++) accum[i] = new THREE.Vector3();
    for (const f of faces) {
      const centroid = new THREE.Vector3();
      for (const vi of f) centroid.add(verts[vi]);
      centroid.multiplyScalar(1 / f.length);
      const normal = new THREE.Vector3();
      for (let i = 0; i < f.length; i++) {
        const p1 = verts[f[i]], p2 = verts[f[(i + 1) % f.length]];
        normal.x += (p1.y - p2.y) * (p1.z + p2.z);
        normal.y += (p1.z - p2.z) * (p1.x + p2.x);
        normal.z += (p1.x - p2.x) * (p1.y + p2.y);
      }
      if (normal.length() < 1e-14) continue;
      normal.normalize();
      for (const vi of f) {
        const p = verts[vi];
        const dist = new THREE.Vector3().subVectors(p, centroid).dot(normal);
        const proj = new THREE.Vector3().subVectors(p, normal.clone().multiplyScalar(dist));
        accum[vi].add(proj); cnt[vi]++;
      }
    }
    const out = new Array(nv);
    for (let i = 0; i < nv; i++) out[i] = cnt[i] > 0 ? accum[i].multiplyScalar(1 / cnt[i]) : verts[i].clone();
    return out;
  }

  // Hart's canonical-form iteration: planarize faces, then nudge edges so their
  // closest-point-to-origin lands on the unit sphere (midsphere), then recenter.
  // The per-edge nudge is additive: translate both endpoints by the same delta that
  // would move the edge's own tangent point onto the unit sphere (delta =
  // closest*(1/|closest|-1)), then average deltas from all of a vertex's incident edges.
  // This is the standard "reciprocal" correction (matching Hart's own algorithm and
  // Antiprism's `canonicalize`) -- NOT the same as rescaling each vertex's whole position
  // by its edge's tangent ratio, which was tried here first and converges to a stable but
  // wrong fixed point whenever a vertex's incident edges belong to different edge orbits
  // (e.g. every fullerene vertex, which touches both pole-adjacent and non-pole-adjacent
  // edges): confirmed by hand this gives fullerene reconstructions a persistent ~0.4-2%
  // edge-length asymmetry between edge orbits that does not shrink with more iterations,
  // where the additive form here converges to machine precision and exact edge equality.
  function canonicalize(poly, maxIter, tol) {
    const verts = poly.verts, faces = poly.faces;
    const nv = verts.length;
    let residual = Infinity;
    for (let iter = 0; iter < maxIter; iter++) {
      const stepA = planarizeStep(poly);

      const accumB = new Array(nv), cntB = new Array(nv).fill(0);
      for (let i = 0; i < nv; i++) accumB[i] = new THREE.Vector3();
      const edgeSeen = new Set();
      for (const f of faces) {
        const n = f.length;
        for (let i = 0; i < n; i++) {
          const u = f[i], w = f[(i + 1) % n];
          const ek = Math.min(u, w) + '_' + Math.max(u, w);
          if (edgeSeen.has(ek)) continue;
          edgeSeen.add(ek);
          const pu = stepA[u], pv = stepA[w];
          const d = new THREE.Vector3().subVectors(pv, pu);
          const dl2 = d.dot(d);
          let t = dl2 > 1e-18 ? -pu.dot(d) / dl2 : 0.5;
          t = Math.max(0, Math.min(1, t));
          const closest = new THREE.Vector3().addVectors(pu, d.clone().multiplyScalar(t));
          const cl = closest.length();
          const delta = cl > 1e-14 ? closest.clone().multiplyScalar(1 / cl - 1) : new THREE.Vector3();
          accumB[u].add(delta); cntB[u]++;
          accumB[w].add(delta); cntB[w]++;
        }
      }
      const stepB = new Array(nv);
      for (let i = 0; i < nv; i++) stepB[i] = cntB[i] > 0 ? stepA[i].clone().add(accumB[i].multiplyScalar(1 / cntB[i])) : stepA[i];

      let tangSum = new THREE.Vector3(); let tangCnt = 0; let maxResidual = 0;
      const seen2 = new Set();
      for (const f of faces) {
        const n = f.length;
        for (let i = 0; i < n; i++) {
          const u = f[i], w = f[(i + 1) % n];
          const ek = Math.min(u, w) + '_' + Math.max(u, w);
          if (seen2.has(ek)) continue;
          seen2.add(ek);
          const pu = stepB[u], pv = stepB[w];
          const d = new THREE.Vector3().subVectors(pv, pu);
          const dl2 = d.dot(d);
          let t = dl2 > 1e-18 ? -pu.dot(d) / dl2 : 0.5;
          t = Math.max(0, Math.min(1, t));
          const closest = new THREE.Vector3().addVectors(pu, d.clone().multiplyScalar(t));
          tangSum.add(closest); tangCnt++;
          maxResidual = Math.max(maxResidual, Math.abs(closest.length() - 1));
        }
      }
      const center = tangCnt > 0 ? tangSum.multiplyScalar(1 / tangCnt) : new THREE.Vector3();
      for (let i = 0; i < nv; i++) verts[i] = new THREE.Vector3().subVectors(stepB[i], center);
      residual = maxResidual;
      if (maxResidual < tol) break;
    }
    return residual;
  }

  // Every undirected edge's length, deduped the same way as canonicalize's edgeSeen/seen2
  // sets and poleContract's poleEdgeOwner (Math.min/max vertex-pair key).
  function edgeStats(poly) {
    const verts = poly.verts, faces = poly.faces;
    const seen = new Set();
    const edges = [];
    let minLen = Infinity, maxLen = -Infinity, sum = 0;
    for (const f of faces) {
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        const len = verts[a].distanceTo(verts[b]);
        edges.push([a, b, len]);
        minLen = Math.min(minLen, len); maxLen = Math.max(maxLen, len); sum += len;
      }
    }
    return { edges, minLen, maxLen, meanLen: edges.length ? sum / edges.length : 0 };
  }

  // Per-face area (shoelace-via-cross-product of position vectors, valid for any planar
  // polygon regardless of choice of origin) plus the mean across all faces.
  function faceAreaStats(poly) {
    const verts = poly.verts, faces = poly.faces;
    const areas = faces.map(f => {
      const normal = new THREE.Vector3();
      for (let i = 0; i < f.length; i++) {
        normal.add(new THREE.Vector3().crossVectors(verts[f[i]], verts[f[(i + 1) % f.length]]));
      }
      return normal.length() * 0.5;
    });
    const mean = areas.length ? areas.reduce((a, b) => a + b, 0) / areas.length : 0;
    return { areas, mean };
  }

  // Unsigned interior angle at each vertex of a face, in the same order as `face`. Good
  // enough for a weak local refiner (faces here are always simple and near-convex; no
  // reflex-angle disambiguation needed).
  function faceInteriorAngles(poly, face) {
    const verts = poly.verts;
    const n = face.length;
    const angles = new Array(n);
    for (let i = 0; i < n; i++) {
      const prev = verts[face[(i - 1 + n) % n]];
      const cur = verts[face[i]];
      const next = verts[face[(i + 1) % n]];
      const u = new THREE.Vector3().subVectors(prev, cur);
      const v = new THREE.Vector3().subVectors(next, cur);
      const cosA = Math.max(-1, Math.min(1, u.dot(v) / (u.length() * v.length())));
      angles[i] = Math.acos(cosA);
    }
    return angles;
  }

  // Local convexity test: for each edge shared by two faces (centroid/outward-normal
  // pairs c1,n1 and c2,n2), the polyhedron is locally convex there iff neither face's
  // centroid pokes through the other's plane. Used by relax() to reject a step that would
  // introduce a dent, for the variants that must stay convex.
  function checkConvex(poly, eps) {
    eps = eps || 1e-7;
    const verts = poly.verts, faces = poly.faces;
    const centroids = faces.map(f => {
      const c = new THREE.Vector3();
      for (const vi of f) c.add(verts[vi]);
      return c.multiplyScalar(1 / f.length);
    });
    // Raw Newell-style cross-product normals follow each face's winding, which
    // fixOrientationConsistency only guarantees to be *consistent* across faces, not
    // necessarily outward -- matching computeDual's own normal computation, flip any
    // face whose normal points toward rather than away from the origin.
    const normals = faces.map((f, fi) => {
      const normal = new THREE.Vector3();
      for (let i = 0; i < f.length; i++) {
        normal.add(new THREE.Vector3().crossVectors(verts[f[i]], verts[f[(i + 1) % f.length]]));
      }
      normal.normalize();
      if (centroids[fi].dot(normal) < 0) normal.multiplyScalar(-1);
      return normal;
    });
    const edgeToFace = new Map();
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (!edgeToFace.has(key)) { edgeToFace.set(key, fi); continue; }
        const fj = edgeToFace.get(key);
        const d1 = new THREE.Vector3().subVectors(centroids[fj], centroids[fi]);
        if (d1.dot(normals[fi]) > eps) return false;
        const d2 = new THREE.Vector3().subVectors(centroids[fi], centroids[fj]);
        if (d2.dot(normals[fj]) > eps) return false;
      }
    }
    return true;
  }

  // Root-mean-square distance of every vertex from the centroid -- a single scalar
  // "size" for the whole polyhedron, used to keep relax() from drifting larger or smaller
  // as it reshapes (edge/area/angle forces have no inherent fixed point for absolute
  // scale, only for relative proportions).
  function rmsRadius(verts) {
    let sumSq = 0;
    for (const v of verts) sumSq += v.lengthSq();
    return Math.sqrt(sumSq / verts.length);
  }

  // Displace verts by `disp` (per-vertex Vector3 or null) scaled by `damping`, then
  // re-flatten faces (planarizeStep), recenter on the vertex centroid, and (when
  // targetScale is given) uniformly rescale back to that RMS radius. Shared by every
  // relax() iteration attempt, including convexity-backtracking retries at reduced damping.
  function applyDisplacements(baseVerts, faces, disp, damping, targetScale) {
    const nv = baseVerts.length;
    const candidate = new Array(nv);
    for (let i = 0; i < nv; i++) {
      candidate[i] = disp[i] ? baseVerts[i].clone().addScaledVector(disp[i], damping) : baseVerts[i].clone();
    }
    const out = planarizeStep({ verts: candidate, faces });
    const centroid = new THREE.Vector3();
    for (const v of out) centroid.add(v);
    centroid.multiplyScalar(1 / out.length);
    for (const v of out) v.sub(centroid);
    if (targetScale) {
      const scale = rmsRadius(out);
      if (scale > 1e-9) { const s = targetScale / scale; for (const v of out) v.multiplyScalar(s); }
    }
    return out;
  }

  // Scalar "how far from the objective" energy matching the forces below: relative
  // edge-length variance, relative face-area variance, and per-face angle-deviation
  // (in radians²), each gated by the same weights relax() uses. This is what makes
  // relax()'s backtracking a true (if heuristic-directed) descent rather than a set of
  // forces that can fight each other into an unbounded drift -- a step is only ever
  // accepted if it actually lowers this number.
  function computeEnergy(poly, edgeWeight, areaWeight, angleWeightFn) {
    let E = 0;
    if (edgeWeight > 0) {
      const { edges, meanLen } = edgeStats(poly);
      if (meanLen > 1e-12) {
        for (const [, , len] of edges) { const r = (len - meanLen) / meanLen; E += edgeWeight * r * r; }
      }
    }
    if (areaWeight > 0) {
      const { areas, mean } = faceAreaStats(poly);
      if (mean > 1e-12) {
        for (const a of areas) { const r = (a - mean) / mean; E += areaWeight * r * r; }
      }
    }
    for (const f of poly.faces) {
      const k = f.length;
      const w = angleWeightFn(k);
      if (w <= 0) continue;
      const target = (k - 2) * Math.PI / k;
      for (const a of faceInteriorAngles(poly, f)) { const d = a - target; E += w * d * d; }
    }
    return E;
  }

  // General-purpose vertex relaxation: iteratively nudges vertices to reduce edge-length
  // variance (edgeWeight), face-area variance (areaWeight), and/or per-face interior-angle
  // deviation from the regular-polygon angle (angleWeight, a function of face size so e.g.
  // triangles can be weighted differently from quads/pentagons/hexagons). Each iteration
  // accumulates a correction per vertex from whichever forces are active, averages
  // contributions from multiple faces/edges touching that vertex (same accumulate-then-
  // divide pattern as canonicalize), applies it with damping, then re-flattens faces via
  // planarizeStep. A step is only accepted if it both (a) keeps the shape convex, when
  // enforceConvexity is set, and (b) strictly lowers computeEnergy() versus the current
  // state -- otherwise damping is halved and the same step retried, up to a few times.
  // Condition (b) is what keeps this numerically stable: the per-vertex corrections below
  // are heuristic descent *directions*, not exact gradients of computeEnergy, so different
  // forces (e.g. global edge-equalization pulling against a per-face angle target) can
  // easily disagree on a shape with structurally different vertex populations (a few
  // "polar" cone vertices vs. many "belt" vertices) -- without an energy check, that
  // disagreement can reinforce itself into unbounded drift (confirmed by hand: an earlier
  // version of this function without the energy check stretched a dual-of-C(n) solid into
  // an ever-sharper diamond instead of converging). With it, every accepted step is a
  // strict improvement, so the process can stall early but never diverges.
  function relax(poly, opts) {
    opts = opts || {};
    const edgeWeight = opts.edgeWeight || 0;
    const areaWeight = opts.areaWeight || 0;
    const angleWeightFn = typeof opts.angleWeight === 'function'
      ? opts.angleWeight
      : (opts.angleWeight ? () => opts.angleWeight : () => 0);
    const enforceConvexity = !!opts.enforceConvexity;
    const maxIter = opts.maxIter || 400;
    const tol = opts.tol || 1e-6;
    const damping = opts.damping || 0.3;

    const verts = poly.verts, faces = poly.faces;
    const nv = verts.length;
    const targetScale = rmsRadius(verts) || 1;
    let residual = Infinity;
    let energy = computeEnergy(poly, edgeWeight, areaWeight, angleWeightFn);

    for (let iter = 0; iter < maxIter; iter++) {
      const accum = new Array(nv), cnt = new Array(nv).fill(0);
      for (let i = 0; i < nv; i++) accum[i] = new THREE.Vector3();

      if (edgeWeight > 0) {
        const { edges, meanLen } = edgeStats(poly);
        for (const [a, b, len] of edges) {
          if (len < 1e-12) continue;
          const dir = new THREE.Vector3().subVectors(verts[b], verts[a]).multiplyScalar(1 / len);
          const delta = (meanLen - len) * 0.5 * edgeWeight;
          accum[a].addScaledVector(dir, -delta); cnt[a]++;
          accum[b].addScaledVector(dir, delta); cnt[b]++;
        }
      }

      if (areaWeight > 0) {
        const { areas, mean } = faceAreaStats(poly);
        faces.forEach((f, fi) => {
          const a = areas[fi];
          if (a < 1e-12 || mean < 1e-12) return;
          const s = Math.sqrt(mean / a);
          const centroid = new THREE.Vector3();
          for (const vi of f) centroid.add(verts[vi]);
          centroid.multiplyScalar(1 / f.length);
          for (const vi of f) {
            const target = centroid.clone().addScaledVector(new THREE.Vector3().subVectors(verts[vi], centroid), s);
            accum[vi].addScaledVector(new THREE.Vector3().subVectors(target, verts[vi]), areaWeight);
            cnt[vi]++;
          }
        });
      }

      for (const f of faces) {
        const k = f.length;
        const w = angleWeightFn(k);
        if (w <= 0) continue;
        const target = (k - 2) * Math.PI / k;
        const angles = faceInteriorAngles(poly, f);
        for (let i = 0; i < k; i++) {
          const prev = verts[f[(i - 1 + k) % k]], cur = verts[f[i]], next = verts[f[(i + 1) % k]];
          const mid = new THREE.Vector3().addVectors(prev, next).multiplyScalar(0.5);
          const outward = new THREE.Vector3().subVectors(cur, mid);
          const outLen = outward.length();
          if (outLen < 1e-12) continue;
          outward.multiplyScalar(1 / outLen);
          const avgAdj = (prev.distanceTo(cur) + next.distanceTo(cur)) * 0.5;
          const diff = target - angles[i];
          accum[f[i]].addScaledVector(outward, diff * avgAdj * 0.5 * w);
          cnt[f[i]]++;
        }
      }

      const disp = new Array(nv);
      let maxMag = 0;
      for (let i = 0; i < nv; i++) {
        if (cnt[i] > 0) {
          disp[i] = accum[i].multiplyScalar(1 / cnt[i]);
          maxMag = Math.max(maxMag, disp[i].length());
        } else disp[i] = null;
      }
      residual = maxMag;
      if (maxMag < tol) break;

      let d = damping, accepted = null, acceptedEnergy = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = applyDisplacements(verts, faces, disp, d, targetScale);
        const candPoly = { verts: candidate, faces };
        const convexOk = !enforceConvexity || checkConvex(candPoly);
        const candEnergy = computeEnergy(candPoly, edgeWeight, areaWeight, angleWeightFn);
        if (convexOk && candEnergy < energy - 1e-12) { accepted = candidate; acceptedEnergy = candEnergy; break; }
        d *= 0.5;
      }
      // No damping level both stayed convex (if required) and lowered the energy --
      // converged (or stalled at a heuristic-direction local limit). Stop rather than
      // keep spinning through the remaining iteration budget for no further change.
      if (!accepted) break;
      for (let i = 0; i < nv; i++) verts[i].copy(accepted[i]);
      energy = acceptedEnergy;
    }
    return { residual, energy };
  }

  // Angle weight functions: 0 for triangles (an equilateral triangle already falls out of
  // edge-equalization alone), ramping up for k>=4 where edge length alone underdetermines
  // shape (e.g. a rhombus has 4 equal sides but two very different angles).
  const NO_ANGLE = () => 0;
  const NONTRI_ANGLE = k => (k <= 3 ? 0 : 1);
  const LIGHT_NONTRI_ANGLE = k => (k <= 3 ? 0 : 0.25);

  // Fullerene view: mostly edge-length equalization. Angle regularity is only lightly
  // weighted -- most fullerene vertices are surrounded by hexagons (hex-hex-hex), and a
  // vertex where all three faces are forced to their regular (120°) angle goes flat/
  // degenerate, so full angle-regularization would fight the shape rather than refine it.
  function relaxFullerene(poly) {
    return relax(poly, { edgeWeight: 1, angleWeight: LIGHT_NONTRI_ANGLE, enforceConvexity: true, maxIter: 400 });
  }

  // Dual of the fullerene: an all-triangle polyhedron, so "as regular-faced as possible"
  // reduces to edge-length equalization (an equilateral triangle is fully determined by
  // its three equal sides). Convexity is not enforced here -- these dual faces can be thin
  // around low-degree dual vertices, and forcing convexity would just stall the relaxation.
  function relaxDualOfFullerene(poly) {
    return relax(poly, { edgeWeight: 1, angleWeight: NO_ANGLE, enforceConvexity: false, maxIter: 400 });
  }

  // Base Catalan-like C(n): equalize face *areas*, not edges or angles.
  function relaxEqualizeFaceAreas(poly) {
    return relax(poly, { areaWeight: 1, enforceConvexity: true, maxIter: 400 });
  }

  // Dual of C(n): regular-faced in the fuller sense -- equalize edges *and* pull
  // non-triangular faces' interior angles toward their regular-polygon angle (weighted
  // more heavily than in the plain Fullerene case, since here that's the actual target,
  // not just a light nudge). Stays convex.
  function relaxDualOfCatalan(poly) {
    return relax(poly, { edgeWeight: 1, angleWeight: NONTRI_ANGLE, enforceConvexity: true, maxIter: 400 });
  }

  // Bridges C(n)-dual and the dual of its reconstructed fullerene for a seamless morph.
  // Pole contraction never touches non-pole faces, so the fullerene's face list is C(n)'s
  // own faces (index-aligned, 0..catalanFaceCount-1, each possibly reshaped if it touched
  // a pole) followed by `poleCount` brand-new small pole faces. Dually, that means
  // fullereneDual and catalanDual share index-aligned vertices for every fi below
  // catalanFaceCount, and fullereneDual has exactly `poleCount` extra vertices with no
  // catalanDual counterpart -- each being the apex of a Conway-kis split of exactly one
  // pole-degree face of catalanDual (confirmed against real data: the kis triangles'
  // non-apex corner pairs are exactly that face's own cyclic edges, nothing else is
  // touched). This builds the "kis'd but flat" companion to fullereneDual -- same face
  // list and vertex count, but every apex sits at its pole face's own centroid, so it's
  // visually indistinguishable from catalanDual itself. Lerping between this and
  // fullereneDual is therefore an ordinary per-vertex morph, reading as pyramids growing
  // out of (or collapsing back into) C(n)-dual's pole faces.
  function buildDualMorphEndpoints(catalanDual, fullereneDual, fullerenePoly, mapping, catalanFaceCount) {
    const Fc = catalanFaceCount;
    const fromVerts = new Array(fullereneDual.verts.length);
    for (let fi = 0; fi < Fc; fi++) fromVerts[fi] = catalanDual.verts[fi].clone();
    for (let fi = Fc; fi < fullerenePoly.faces.length; fi++) {
      const P = mapping[fullerenePoly.faces[fi][0]]; // pole vertex this new face belongs to
      const corners = catalanDual.faces[P]; // P doubles as catalanDual's own face index
      const centroid = new THREE.Vector3();
      for (const c of corners) centroid.add(catalanDual.verts[c]);
      fromVerts[fi] = centroid.multiplyScalar(1 / corners.length);
    }
    return { verts: fromVerts, faces: fullereneDual.faces };
  }

  function computeInvariants(poly) {
    const verts = poly.verts, faces = poly.faces;
    const { areas } = faceAreaStats(poly);
    const areaMin = Math.min(...areas), areaMax = Math.max(...areas);
    let dMin = Infinity, dMax = -Infinity;
    const counts = { a3: 0, a4: 0, a5: 0 };
    for (const f of faces) {
      const centroid = new THREE.Vector3();
      for (const vi of f) centroid.add(verts[vi]);
      centroid.multiplyScalar(1 / f.length);
      const normal = new THREE.Vector3();
      for (let i = 0; i < f.length; i++) {
        const p1 = verts[f[i]], p2 = verts[f[(i + 1) % f.length]];
        normal.add(new THREE.Vector3().crossVectors(p1, p2));
      }
      const dist = Math.abs(centroid.dot(normal.clone().normalize()));
      dMin = Math.min(dMin, dist); dMax = Math.max(dMax, dist);
      if (f.length === 3) counts.a3++; else if (f.length === 4) counts.a4++; else if (f.length === 5) counts.a5++;
    }
    const { minLen, maxLen } = edgeStats(poly);
    return {
      rho: areaMax / areaMin, iota: dMin / dMax, edgeRatio: maxLen / minLen,
      areaMin, areaMax, dMin, dMax, counts
    };
  }

  function validateFullereneTopology(poly, expectV, opts) {
    const poleDegree = (opts && opts.poleDegree) || 5;
    const expectedPoleCount = (opts && opts.expectedPoleCount) || 12;
    const faces = poly.faces;
    const nv = poly.verts.length;
    if (nv !== expectV) return { ok: false };
    const edgeCount = new Map();
    for (const f of faces) {
      if (f.length < 3) return { ok: false };
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        if (a === b) return { ok: false };
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      }
    }
    for (const c of edgeCount.values()) if (c !== 2) return { ok: false };
    const deg = new Array(nv).fill(0);
    for (const key of edgeCount.keys()) { const [a, b] = key.split('_').map(Number); deg[a]++; deg[b]++; }
    if (!deg.every(d => d === 3)) return { ok: false };
    let poleFaceCount = 0, other = 0;
    for (const f of faces) { if (f.length === poleDegree) poleFaceCount++; else if (f.length !== 6) other++; }
    if (poleFaceCount !== expectedPoleCount || other !== 0) return { ok: false };
    return { ok: true };
  }

  // Combinatorial + polar-reciprocal dual of a poly already realized in (approximately)
  // midsphere-canonical form, i.e. every edge tangent to the unit sphere -- true of every
  // C(n) and fullerene reconstruction in this app. Each dual vertex is the polar reciprocal
  // of an original face's supporting plane: a face at distance d from the origin with
  // outward unit normal n̂ maps to the point n̂/d. A polyhedron's polar dual taken w.r.t. its
  // own midsphere is itself midsphere-canonical (a classical fact), so this produces a
  // genuinely canonical dual whenever the input already is one, not just a combinatorial
  // stand-in. Requires poly's faces to be consistently oriented (every caller here already
  // runs fixOrientationConsistency before this point).
  function computeDual(poly) {
    const verts = poly.verts, faces = poly.faces;
    const nv = verts.length;

    const dualVerts = faces.map(f => {
      const centroid = new THREE.Vector3();
      for (const vi of f) centroid.add(verts[vi]);
      centroid.multiplyScalar(1 / f.length);
      const normal = new THREE.Vector3();
      for (let i = 0; i < f.length; i++) {
        normal.add(new THREE.Vector3().crossVectors(verts[f[i]], verts[f[(i + 1) % f.length]]));
      }
      normal.normalize();
      if (centroid.dot(normal) < 0) normal.multiplyScalar(-1);
      const dist = Math.max(Math.abs(centroid.dot(normal)), 1e-9);
      return normal.multiplyScalar(1 / dist);
    });

    // Dual faces = original vertices; each dual face's vertex sequence is the cyclic fan
    // of original faces around that vertex. With consistent orientation, the face adjacent
    // to the current one (rotating around v) is whichever face has the directed edge
    // (v, prevVertexInCurrentFace) -- the same edge the current face has as
    // (prevVertexInCurrentFace, v), traversed the other way by its neighbour across it.
    const edgeToFace = new Map();
    faces.forEach((f, fi) => {
      const n = f.length;
      for (let i = 0; i < n; i++) edgeToFace.set(f[i] + '_' + f[(i + 1) % n], fi);
    });

    const dualFaces = [];
    for (let v = 0; v < nv; v++) {
      let startFace = -1;
      for (let fi = 0; fi < faces.length; fi++) if (faces[fi].includes(v)) { startFace = fi; break; }
      if (startFace === -1) continue;
      const fan = [];
      let curFace = startFace;
      for (let guard = 0; guard <= faces.length; guard++) {
        fan.push(curFace);
        const f = faces[curFace];
        const idx = f.indexOf(v);
        const prevVert = f[(idx - 1 + f.length) % f.length];
        const nextFace = edgeToFace.get(v + '_' + prevVert);
        if (nextFace === undefined || nextFace === startFace) break;
        curFace = nextFace;
      }
      dualFaces.push(fan);
    }

    return { verts: dualVerts, faces: dualFaces };
  }

  // ===================================================================================
  // Point-group symmetry detection. Finds the exact finite symmetry group of a poly's
  // vertex set (about the origin) by: (1) collecting candidate axes from every vertex,
  // face centroid, and edge midpoint direction -- any true symmetry axis of a polyhedron
  // in this app's tet/oct/icos-family construction passes through one of those three kinds
  // of points; (2) testing rotation/reflection/improper-rotation matrices about each
  // candidate axis directly against the vertex set; (3) computing the *group closure* of
  // whatever matrices pass, by repeated matrix multiplication until no new matrix appears.
  //
  // The closure step matters: naively counting how many (axis, operation) pairs pass is
  // NOT the group order (verified by hand -- it gave 63 for a shape whose true symmetry
  // order is 120), because many detections are redundant representations of the same few
  // true group elements. Deduplicating by the actual 3x3 matrix and closing under
  // multiplication gives the exact order every time.
  // ===================================================================================

  function matKey(m) { return m.map(x => (Math.round(x * 1000) / 1000).toFixed(3)).join(','); }
  function matMul(a, b) {
    const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return r;
  }
  function matApply(m, v) {
    return new THREE.Vector3(
      m[0] * v.x + m[1] * v.y + m[2] * v.z,
      m[3] * v.x + m[4] * v.y + m[5] * v.z,
      m[6] * v.x + m[7] * v.y + m[8] * v.z
    );
  }
  const SYM_IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const SYM_INVERSION = [-1, 0, 0, 0, -1, 0, 0, 0, -1];
  function rotationMatrix(axis, angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const e = m.elements; // column-major
    return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
  }
  function reflectionMatrix(n) {
    return [
      1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z,
      -2 * n.x * n.y, 1 - 2 * n.y * n.y, -2 * n.y * n.z,
      -2 * n.x * n.z, -2 * n.y * n.z, 1 - 2 * n.z * n.z
    ];
  }

  // The exact closed symmetry group of poly's vertex set, plus a classification
  // signature (order, chirality, inversion, highest proper-rotation order) that
  // uniquely identifies every point group in SYMMETRY_TABLE below.
  function detectSymmetryGroup(poly, tol) {
    tol = tol || 1e-3;
    // Widened only for the initial reflection scan below -- a candidate axis sourced
    // from raw vertex/face/edge directions can be off by a fraction of a degree even
    // when the underlying mirror plane is exact (confirmed on real data: icosahedral
    // n=31's best candidate mirror misses at the default tol by ~0.66% of the vertex
    // radius). Any match found only at this looser tolerance gets its axis rebuilt from
    // the actual matched-pair geometry and re-verified at the strict tol before being
    // trusted (see refineReflectionAxis) -- feeding the raw noisy axis straight into the
    // group-closure loop instead was tried and rejected: composing it with other exact
    // generators doesn't cleanly close, it cascades into a runaway, ever-growing set of
    // near-orthogonal matrices (839+ and still climbing after just 4 closure passes).
    const REFLECT_DETECT_TOL = 0.01;
    const verts = poly.verts;
    const nv = verts.length;

    function findVertexIndex(p, useTol) {
      const t = useTol || tol;
      for (let i = 0; i < nv; i++) if (verts[i].distanceTo(p) < t) return i;
      return -1;
    }
    function matValid(m, useTol) {
      const used = new Array(nv).fill(false);
      for (let i = 0; i < nv; i++) {
        const j = findVertexIndex(matApply(m, verts[i]), useTol);
        if (j === -1 || used[j]) return false;
        used[j] = true;
      }
      return true;
    }
    // Recovers the exact mirror normal from an axis that only validates at the loosened
    // tolerance: for every genuinely-reflected vertex pair (i, j), verts[i] - verts[j] is
    // exactly parallel to the true normal, so averaging over all such pairs cancels the
    // per-vertex noise that threw off the original candidate axis (validated on n=31: a
    // candidate 0.3 degrees off, 0.66% worst-vertex mismatch, refines to <1e-14).
    function refineReflectionAxis(axis) {
      const m = reflectionMatrix(axis);
      const refined = new THREE.Vector3();
      let count = 0;
      for (let i = 0; i < nv; i++) {
        const j = findVertexIndex(matApply(m, verts[i]), REFLECT_DETECT_TOL);
        if (j === -1 || j === i) continue;
        const d = new THREE.Vector3().subVectors(verts[i], verts[j]);
        if (d.length() < 1e-6) continue;
        d.normalize();
        if (d.dot(axis) < 0) d.multiplyScalar(-1);
        refined.add(d);
        count++;
      }
      if (count === 0) return null;
      return refined.divideScalar(count).normalize();
    }

    const candidateAxes = [];
    const seenAxis = new Set();
    function addAxis(v) {
      if (v.length() < 1e-4) return;
      const n = v.clone().normalize();
      // canonicalize sign so +n and -n (the same axis line) dedupe to one entry
      if (n.x < -1e-6 || (Math.abs(n.x) < 1e-6 && n.y < -1e-6) || (Math.abs(n.x) < 1e-6 && Math.abs(n.y) < 1e-6 && n.z < 0)) n.multiplyScalar(-1);
      const key = n.toArray().map(x => x.toFixed(3)).join(',');
      if (seenAxis.has(key)) return;
      seenAxis.add(key);
      candidateAxes.push(n);
    }
    for (const v of verts) addAxis(v);
    for (const f of poly.faces) {
      const c = new THREE.Vector3();
      for (const vi of f) c.add(verts[vi]);
      addAxis(c);
    }
    const edgeSeen = new Set();
    for (const f of poly.faces) {
      const k = f.length;
      for (let i = 0; i < k; i++) {
        const a = f[i], b = f[(i + 1) % k];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (edgeSeen.has(key)) continue;
        edgeSeen.add(key);
        addAxis(new THREE.Vector3().addVectors(verts[a], verts[b]));
      }
    }

    // Reflection normals get their own, larger candidate set. A rotation axis or an
    // improper-rotation axis always passes through an invariant point of the solid (a
    // vertex, a face center, or an edge midpoint), which is why sampling those directions
    // from the origin works for both -- but a mirror plane doesn't need to pass through
    // any single such point at all. A "diagonal" (sigma_d) mirror of an antiprismatic
    // solid, for instance, only ever touches the surface at vertices (never at a face
    // center or edge midpoint), so its normal is orthogonal to every one of those
    // directions rather than aligned with any of them -- confirmed on real data: the dual
    // of tetrahedral C(n=10) is an exact biaugmented square antiprism (genuine D4d), yet
    // not one of its vertex/face/edge directions comes within 60% of any of its actual
    // mirror normals. What a mirror DOES guarantee is that it pairs up same-radius
    // vertices (or fixes them), so verts[i]-verts[j] for any two vertices at equal
    // distance from the shared center is exactly parallel to that mirror's normal --
    // bucketing by radius keeps this cheap by only ever pairing vertices that could
    // plausibly be swapped by the same reflection.
    const reflectionCandidateAxes = candidateAxes.slice();
    {
      const seenReflAxis = new Set(candidateAxes.map(a => a.toArray().map(x => x.toFixed(3)).join(',')));
      function addReflAxis(v) {
        if (v.length() < 1e-4) return;
        const n = v.clone().normalize();
        if (n.x < -1e-6 || (Math.abs(n.x) < 1e-6 && n.y < -1e-6) || (Math.abs(n.x) < 1e-6 && Math.abs(n.y) < 1e-6 && n.z < 0)) n.multiplyScalar(-1);
        const key = n.toArray().map(x => x.toFixed(3)).join(',');
        if (seenReflAxis.has(key)) return;
        seenReflAxis.add(key);
        reflectionCandidateAxes.push(n);
      }
      const buckets = new Map();
      for (let i = 0; i < nv; i++) {
        const key = verts[i].length().toFixed(3);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
      }
      for (const idxs of buckets.values()) {
        if (idxs.length > 40) continue; // pathological safety cap, never expected in practice
        for (let a = 0; a < idxs.length; a++) {
          for (let b = a + 1; b < idxs.length; b++) {
            addReflAxis(new THREE.Vector3().subVectors(verts[idxs[a]], verts[idxs[b]]));
          }
        }
      }
    }

    const gens = new Map();
    gens.set(matKey(SYM_IDENTITY), SYM_IDENTITY);
    for (const axis of candidateAxes) {
      for (const k of [2, 3, 4, 5, 6]) {
        const m = rotationMatrix(axis, 2 * Math.PI / k);
        if (matValid(m)) gens.set(matKey(m), m);
      }
    }
    for (const axis of reflectionCandidateAxes) {
      let m = reflectionMatrix(axis);
      if (!matValid(m)) {
        if (!matValid(m, REFLECT_DETECT_TOL)) continue;
        const refinedAxis = refineReflectionAxis(axis);
        if (!refinedAxis) continue;
        m = reflectionMatrix(refinedAxis);
        if (!matValid(m)) continue; // still doesn't hold at the strict tol -- not a real mirror
      }
      gens.set(matKey(m), m);
    }
    if (matValid(SYM_INVERSION)) gens.set(matKey(SYM_INVERSION), SYM_INVERSION);
    for (const axis of candidateAxes) {
      for (const k of [3, 4, 5, 6]) {
        const m = matMul(reflectionMatrix(axis), rotationMatrix(axis, 2 * Math.PI / k));
        if (matValid(m)) gens.set(matKey(m), m);
      }
    }

    // Group closure: repeatedly multiply pairs until a full pass adds nothing new.
    // SYM_GROUP_MAX guards against the runaway case described above (a noisy generator
    // that doesn't actually close into a genuine finite group, which the iter<20 cap alone
    // doesn't bound -- each pass's work is frontier x group.size, so an ever-growing group
    // makes later passes quadratically more expensive, and 20 passes of that can run long
    // enough to look like -- and in practice, briefly was -- a hung tab). No real point
    // group relevant here exceeds order 120 (Ih); breaking well above that turns a
    // pathological input into an honest "gave up" (falls through to describeSymmetryGroup's
    // raw "order N" fallback label) instead of a multi-minute freeze.
    const SYM_GROUP_MAX = 240;
    let group = new Map(gens);
    let frontier = [...group.values()];
    let changed = true, iter = 0;
    outer:
    while (changed && iter < 20) {
      changed = false; iter++;
      const newOnes = [];
      for (const a of frontier) {
        for (const b of group.values()) {
          const m = matMul(a, b);
          const key = matKey(m);
          if (!group.has(key)) {
            group.set(key, m); newOnes.push(m); changed = true;
            if (group.size > SYM_GROUP_MAX) break outer;
          }
        }
      }
      frontier = newOnes;
    }

    const hasInversion = group.has(matKey(SYM_INVERSION));
    let chiral = true;
    const properRotations = []; // {order, axis}
    const reflectionNormals = [];
    for (const m of group.values()) {
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      if (det < 0) {
        chiral = false;
        // Pure reflections have trace 1 (eigenvalues 1,1,-1); pick out their mirror
        // normal via (I-M)/2 = n·n^T, extracting n from whichever row has the largest
        // magnitude (robust to which row happens to be near-zero for a given orientation).
        const trace = m[0] + m[4] + m[8];
        if (Math.abs(trace - 1) < 1e-2) {
          const A = [(1 - m[0]) / 2, -m[1] / 2, -m[2] / 2, -m[3] / 2, (1 - m[4]) / 2, -m[5] / 2, -m[6] / 2, -m[7] / 2, (1 - m[8]) / 2];
          let bestRow = 0, bestNormSq = -1;
          for (let r = 0; r < 3; r++) {
            const normSq = A[r * 3] ** 2 + A[r * 3 + 1] ** 2 + A[r * 3 + 2] ** 2;
            if (normSq > bestNormSq) { bestNormSq = normSq; bestRow = r; }
          }
          const nvec = new THREE.Vector3(A[bestRow * 3], A[bestRow * 3 + 1], A[bestRow * 3 + 2]);
          if (nvec.length() > 1e-6) reflectionNormals.push(nvec.normalize());
        }
        continue;
      }
      const trace = m[0] + m[4] + m[8];
      const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
      if (angle < 1e-3) continue; // identity
      const order = Math.round(2 * Math.PI / angle);
      // Rotation axis: for angle != 180°, from the antisymmetric part (M - M^T);
      // for a true 180° rotation that part vanishes, so fall back to the eigenvector
      // of (M+I)/2 (same rank-1-extraction trick used for reflection normals above).
      let axis;
      const axisRaw = new THREE.Vector3(m[7] - m[5], m[2] - m[6], m[3] - m[1]);
      if (axisRaw.length() > 1e-4) {
        axis = axisRaw.normalize();
      } else {
        const B = [(m[0] + 1) / 2, m[1] / 2, m[2] / 2, m[3] / 2, (m[4] + 1) / 2, m[5] / 2, m[6] / 2, m[7] / 2, (m[8] + 1) / 2];
        let bestRow = 0, bestNormSq = -1;
        for (let r = 0; r < 3; r++) {
          const normSq = B[r * 3] ** 2 + B[r * 3 + 1] ** 2 + B[r * 3 + 2] ** 2;
          if (normSq > bestNormSq) { bestNormSq = normSq; bestRow = r; }
        }
        axis = new THREE.Vector3(B[bestRow * 3], B[bestRow * 3 + 1], B[bestRow * 3 + 2]).normalize();
      }
      // M and M^(k-1) for the same physical axis extract as antiparallel vectors (+n vs
      // -n) since they're geometrically "rotate +θ about n" vs "rotate +θ about -n" --
      // canonicalize the sign (same convention as addAxis above) so they dedupe to one
      // axis instead of two.
      if (axis.x < -1e-6 || (Math.abs(axis.x) < 1e-6 && axis.y < -1e-6) || (Math.abs(axis.x) < 1e-6 && Math.abs(axis.y) < 1e-6 && axis.z < 0)) axis.multiplyScalar(-1);
      properRotations.push({ order, axis });
    }

    let maxProperRotationOrder = 1;
    for (const r of properRotations) maxProperRotationOrder = Math.max(maxProperRotationOrder, r.order);
    const principalAxisKeys = new Set();
    let principalAxis = null;
    for (const r of properRotations) {
      if (r.order !== maxProperRotationOrder) continue;
      const key = r.axis.toArray().map(x => x.toFixed(3)).join(',');
      if (!principalAxisKeys.has(key)) { principalAxisKeys.add(key); if (!principalAxis) principalAxis = r.axis; }
    }
    let hasHorizontalMirror = false, verticalMirrorCount = 0;
    if (principalAxis) {
      for (const n of reflectionNormals) {
        const d = Math.abs(n.dot(principalAxis));
        if (d > 0.99) hasHorizontalMirror = true;
        else if (d < 0.1) verticalMirrorCount++;
      }
    }

    return {
      order: group.size, chiral, hasInversion, maxProperRotationOrder,
      numPrincipalAxes: principalAxisKeys.size, hasHorizontalMirror, verticalMirrorCount,
      groupMatrices: Array.from(group.values()), properRotations
    };
  }

  function canonicalizeAxisSign(v) {
    if (v.x < -1e-6 || (Math.abs(v.x) < 1e-6 && v.y < -1e-6) || (Math.abs(v.x) < 1e-6 && Math.abs(v.y) < 1e-6 && v.z < 0)) v.multiplyScalar(-1);
    return v;
  }

  // Distinct rotation axes ("Stella-style" symmetry-axis rods): every proper rotation in
  // the closed group shares its axis with exactly (n-1) other non-identity rotations when
  // that axis is a genuine Cn axis (the k=1..n-1 powers) -- so bucketing properRotations by
  // axis and taking bucket size + 1 gives the true axis order n directly, robustly (unlike
  // reading `order` off any single matrix's own rotation angle, which is only correct for
  // the primitive k=1 power -- e.g. a C5 axis's k=2 matrix rotates by 144°, which taken
  // alone would misread as order 3, not 5).
  //
  // Same order alone does NOT mean same color: two Cn axes only share a class if some
  // operation of the solid's own symmetry group actually carries one onto the other (as a
  // line -- an axis has no inherent direction, so sign is ignored) -- the identical
  // "genuinely transitive" standard computeFaceSymmetryOrbits applies to faces. A regular
  // pentagonal prism's five C2' axes are all equivalent under its C5 rotation, but an
  // irregular D5h Catalan-like solid can have those same five 2-fold axes split into more
  // than one orbit (through-vertex vs. through-edge, say) despite sharing order 2 --
  // conjugating a rotation by any group element preserves its rotation angle, so every axis
  // in one orbit is guaranteed the same order, making per-orbit order well-defined.
  // Orbits are ranked by order descending (ties broken by first-encountered axis, for a
  // deterministic result) and given sequential ranks, so the highest-order axis family
  // still gets the first color, but two distinct orbits of the same order always get two
  // different colors rather than collapsing into one.
  function computeSymmetryAxes(poly, tol) {
    const { properRotations, groupMatrices } = detectSymmetryGroup(poly, tol);
    const buckets = new Map();
    for (const { axis } of properRotations) {
      const key = axis.toArray().map(x => x.toFixed(3)).join(',');
      if (!buckets.has(key)) buckets.set(key, { axis, count: 0 });
      buckets.get(key).count++;
    }
    const axisList = Array.from(buckets.values()).map(b => ({ axis: b.axis, order: b.count + 1 }));
    const na = axisList.length;

    const axisKeyOf = v => v.toArray().map(x => x.toFixed(3)).join(',');
    const indexByKey = new Map(axisList.map((a, i) => [axisKeyOf(a.axis), i]));
    const parent = Array.from({ length: na }, (_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }
    for (let i = 0; i < na; i++) {
      for (const m of groupMatrices) {
        const mapped = canonicalizeAxisSign(matApply(m, axisList[i].axis));
        const j = indexByKey.get(axisKeyOf(mapped));
        if (j != null) union(i, j);
      }
    }

    const byRoot = new Map();
    for (let i = 0; i < na; i++) {
      const r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(i);
    }
    const orbits = Array.from(byRoot.values()).map(idxs => ({ idxs, order: axisList[idxs[0]].order, first: idxs[0] }));
    orbits.sort((a, b) => b.order - a.order || a.first - b.first);

    const rank = new Array(na);
    orbits.forEach((o, r) => { for (const i of o.idxs) rank[i] = r; });
    return axisList.map((a, i) => ({ axis: a.axis, order: a.order, rank: rank[i] }));
  }

  // The "irregular" groups -- multiple equivalent high-order axes, so they don't fit the
  // single-principal-axis Cn/Dn/Cnv/Cnh/Dnd/Dnh family below. Keyed by
  // "order,chiral,hasInversion,maxProperRotationOrder", verified against real app data
  // (every entry below was confirmed against an actual n in this app, not just reasoned
  // about -- see the geometry-viewer session notes).
  const SYMMETRY_TABLE = {
    '1,true,false,1': { symbol: 'C1', name: 'no symmetry' },
    '2,false,true,1': { symbol: 'Ci', name: 'inversion only' },
    '2,false,false,1': { symbol: 'Cs', name: 'single mirror' },
    '12,true,false,3': { symbol: 'T', name: 'chiral tetrahedral' },
    '24,true,false,4': { symbol: 'O', name: 'chiral octahedral' },
    '24,false,false,3': { symbol: 'Td', name: 'full tetrahedral' },
    '24,false,true,3': { symbol: 'Th', name: 'pyritohedral' },
    '48,false,true,4': { symbol: 'Oh', name: 'full octahedral' },
    '60,true,false,5': { symbol: 'I', name: 'chiral icosahedral' },
    '120,false,true,5': { symbol: 'Ih', name: 'full icosahedral' }
  };

  // For a single-principal-axis group (exactly one axis achieves the highest proper
  // rotation order k), classify into the standard Cn/Dn/Cnv/Cnh/Dnd/Dnh family by order
  // and mirror orientation -- generic in k, so it covers C5, D5h, D6d, D7, ... without
  // needing a table entry per n. (Verified against real data: icos n=25 -> order 20,
  // one 5-fold axis, horizontal + 5 vertical mirrors -> D5h; icos n=26 -> order 24, one
  // 6-fold axis, no horizontal mirror, 6 vertical mirrors -> D6d, not the "D6"/"D6h" one
  // might guess from n alone.)
  function classifyAxialFamily(sig) {
    if (sig.maxProperRotationOrder < 2) return null;
    const k = sig.maxProperRotationOrder;
    // D2/D2h/D2d's three C2 axes are mutually equivalent (none is more "principal" than
    // the others), unlike every higher Dn -- so this is the one case genuinely
    // identified by *three* equal-order axes rather than one. Named the same terse way
    // as every other Dn/Dnh/Dnd (just "2-fold", not "2,2,2-fold") -- the symbol alone
    // already implies the three-axis structure, the same way D5d implies its 5
    // perpendicular 2-folds without spelling them out. (Verified against real data: icos
    // n=44 -> order 4, chiral, three C2 axes -> D2; icos n=32 -> order 8, achiral, no
    // inversion -> D2d.)
    if (k === 2 && sig.numPrincipalAxes === 3) {
      if (sig.order === 4 && sig.chiral) return { symbol: 'D2', name: 'chiral 2-fold prismatic' };
      if (sig.order === 8 && !sig.chiral && sig.hasInversion) return { symbol: 'D2h', name: 'full 2-fold prismatic' };
      if (sig.order === 8 && !sig.chiral && !sig.hasInversion) return { symbol: 'D2d', name: '2-fold antiprismatic' };
      return null;
    }
    if (sig.numPrincipalAxes !== 1) return null;
    // Names below match real chemistry/crystallography shape terms, not ad-hoc
    // descriptions -- an n-gonal pyramid genuinely has Cnv symmetry, an n-gonal prism
    // genuinely has Dnh, an n-gonal antiprism genuinely has Dnd. Cn and Cnv share the
    // "pyramidal" word (chiral/full, matching the T/Td, O/Oh, I/Ih pairing already used
    // above) since both have exactly one distinguished axis with no top/bottom mirror --
    // Cnv just additionally has the vertical mirrors a real (achiral) pyramid has.
    // Dn is forced into the same "prismatic" word as Dnh even though a chiral Dn shape is
    // really a *twisted* prism (some angle strictly between an unwound prism and a fully
    // wound antiprism) -- an intentional simplification to keep the chiral/full pairing
    // uniform, at the cost of nudging the naming toward the prism side over the antiprism
    // side. Dnd's "antiprismatic" drops the "full" qualifier that every other achiral name
    // gets: unlike Dnh (which shares "prismatic" with chiral Dn and needs "full" to stay
    // distinct from it), Dnd doesn't share its word with anything chiral to disambiguate
    // from -- same reasoning as Th staying "pyritohedral" instead of "full tetrahedral".
    if (sig.order === k && sig.chiral) return { symbol: `C${k}`, name: `chiral ${k}-fold pyramidal` };
    if (sig.order === 2 * k && sig.chiral) return { symbol: `D${k}`, name: `chiral ${k}-fold prismatic` };
    if (sig.order === 2 * k && !sig.chiral && sig.hasHorizontalMirror) return { symbol: `C${k}h`, name: `full ${k}-fold planar` };
    if (sig.order === 2 * k && !sig.chiral && !sig.hasHorizontalMirror) return { symbol: `C${k}v`, name: `full ${k}-fold pyramidal` };
    if (sig.order === 4 * k && !sig.chiral && sig.hasHorizontalMirror) return { symbol: `D${k}h`, name: `full ${k}-fold prismatic` };
    if (sig.order === 4 * k && !sig.chiral && !sig.hasHorizontalMirror) return { symbol: `D${k}d`, name: `${k}-fold antiprismatic` };
    return null;
  }

  // Human-readable symmetry description for poly, e.g. "Ih (full icosahedral)" or
  // "D5h (5-fold prismatic)". Falls back to the raw, honest signature
  // ("order 4 (chiral)") rather than guessing a name when the detected group matches
  // neither the irregular table nor the generic axial-family pattern.
  function describeSymmetryGroup(poly, tol) {
    const sig = detectSymmetryGroup(poly, tol);
    const key = `${sig.order},${sig.chiral},${sig.hasInversion},${sig.maxProperRotationOrder}`;
    const known = SYMMETRY_TABLE[key] || classifyAxialFamily(sig);
    if (known) return { label: `${known.symbol} (${known.name})`, ...sig, ...known };
    const descriptor = sig.chiral ? 'chiral' : (sig.hasInversion ? 'with inversion' : 'achiral');
    return { label: `order ${sig.order} (${descriptor})`, ...sig };
  }

  // ===================================================================================
  // Face symmetry orbits ("colour by symmetry", as in Stella): two faces belong to the
  // same class iff some operation of the solid's own symmetry group (rotation OR
  // reflection -- the same closed group detectSymmetryGroup computes) maps one face's
  // exact vertex set onto the other's. This is stricter than same-shape/same-size (which
  // classifyFace in render.js uses): e.g. two congruent faces on opposite sides of a
  // C1 (asymmetric) solid are the same shape but NOT symmetry-transitive, so they must
  // get different colors here even though a shape-based coloring would lump them
  // together -- and conversely a mirror can relate two faces that read as distinct
  // "chiralities" of the same shape, which still counts as one class here.
  // Faces are matched by vertex-index SET (not sequence) after applying each group
  // matrix: a rotation/reflection carries a face's vertex ring onto another face's ring
  // as a set regardless of any relabeling or winding-direction flip a reflection
  // introduces, and every face in this app's polyhedra has a unique vertex set, so set
  // equality is exactly "this is the same face".
  // ===================================================================================
  function computeFaceSymmetryOrbits(poly, tol) {
    tol = tol || 1e-3;
    const groupMatrices = detectSymmetryGroup(poly, tol).groupMatrices;
    const verts = poly.verts, faces = poly.faces;
    const nf = faces.length;

    function findVertex(p) {
      for (let i = 0; i < verts.length; i++) if (verts[i].distanceTo(p) < tol) return i;
      return -1;
    }
    const faceByVertSet = new Map();
    faces.forEach((f, fi) => faceByVertSet.set(f.slice().sort((a, b) => a - b).join(','), fi));

    const parent = Array.from({ length: nf }, (_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }

    for (const m of groupMatrices) {
      for (let fi = 0; fi < nf; fi++) {
        const mapped = faces[fi].map(vi => findVertex(matApply(m, verts[vi])));
        if (mapped.some(x => x === -1)) continue;
        const fj = faceByVertSet.get(mapped.slice().sort((a, b) => a - b).join(','));
        if (fj != null) union(fi, fj);
      }
    }

    const { areas } = faceAreaStats(poly);
    const byRoot = new Map();
    for (let fi = 0; fi < nf; fi++) {
      const r = find(fi);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(fi);
    }
    // Larger face area = higher priority (earlier palette color), ties broken by
    // first-encountered face index so the assignment is deterministic run to run.
    const orbitList = Array.from(byRoot.values()).map(idxs => ({ idxs, area: areas[idxs[0]], first: idxs[0] }));
    orbitList.sort((a, b) => b.area - a.area || a.first - b.first);

    const orbitIndex = new Array(nf);
    orbitList.forEach((o, rank) => { for (const fi of o.idxs) orbitIndex[fi] = rank; });
    return { orbitIndex, orbitCount: orbitList.length, orbitSizes: orbitList.map(o => o.idxs.length), orbitAreas: orbitList.map(o => o.area) };
  }

  global.Geo = {
    poleContract, poleExpand, fixOrientationConsistency, sphereRelax, canonicalize,
    computeInvariants, validateFullereneTopology, computeDual,
    planarizeStep, edgeStats, faceAreaStats, faceInteriorAngles, checkConvex, relax,
    relaxFullerene, relaxDualOfFullerene, relaxEqualizeFaceAreas, relaxDualOfCatalan,
    buildDualMorphEndpoints, detectSymmetryGroup, describeSymmetryGroup, computeFaceSymmetryOrbits,
    computeSymmetryAxes
  };
})(window);

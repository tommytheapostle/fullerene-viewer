// ===================================================================================
// app.js — UI wiring, state. No build step; everything lives in memory.
// ===================================================================================
(function () {
  'use strict';

  // Global symmetry mode: icosahedral (12 pentagon poles, degree 5) is the original mode;
  // octahedral (6 quad poles, degree 4) and tetrahedral (4 triangle poles, degree 3) reuse
  // the same C(n)-contraction pipeline against their own admissible-solution tables.
  // MODE_ORDER controls both the on-screen button order and iteration order elsewhere;
  // it is independent of which mode is active by default (see state.mode below).
  // The literal "n" stays lowercase even though this label is styled all-caps like every
  // other section header (label { text-transform: uppercase } in index.html) -- .lit-n
  // opts it out. Set via innerHTML (see switchMode), not textContent, so the span survives.
  const nRangeLabelHtml = range => `<span class="lit-n">n</span> — fullerene's hexagon count (${range})`;

  const MODES = {
    tet: {
      key: 'tet', label: 'Tetrahedral',
      nMin: 4, nMax: 12, nDefault: 4,
      poleDegree: 3, poleCount: 4, poleShapeName: 'triangle',
      fullereneAvailable: true,
      table: () => window.TET_TABLE,
      invalidTable: () => window.TET_INVALID_TABLE,
      subtitleHtml: 'σ contracts the 4 triangles of the tetrahedral fullerene C<sub>2n+4</sub> to pole-vertices, producing its corresponding Catalan-like solid C(n)',
      nRangeLabel: nRangeLabelHtml('4–12'),
      exportFullerenePrefix: 'tet_fullerene_C',
      fullereneVertexCount: n => 2 * n + 4,
      // Provably impossible, not just unpublished: a (3,6)-fullerene needs V = 2n+4 cage
      // vertices, and V must be a multiple of 4 (its sphere is a quotient of the hexagonal
      // lattice by a group with exactly 4 order-3 cone points, forcing V = 4(s+1)(b+1) --
      // see "Enumeration formulas for (3,6)-fullerenes", arXiv:2501.09170). 2n+4 is only ever
      // a multiple of 4 when n is even, so odd n admits no such graph at all, valid or not
      // (confirmed independently here by an exhaustive-feeling search that instantly finds
      // n=4,6,8,10,12 but never n=5,7,9,11 regardless of budget or annealing schedule).
      isImpossibleN: n => n % 2 === 1,
      impossibleReason: 'No (3,6)-fullerene exists for odd n.'
    },
    oct: {
      key: 'oct', label: 'Octahedral',
      nMin: 8, nMax: 24, nDefault: 8,
      poleDegree: 4, poleCount: 6, poleShapeName: 'quad',
      fullereneAvailable: true,
      table: () => window.OCT_TABLE,
      invalidTable: () => window.OCT_INVALID_TABLE,
      subtitleHtml: 'σ contracts the 6 quads of the octahedral fullerene C<sub>2n+8</sub> to pole-vertices, producing its corresponding Catalan-like solid C(n)',
      nRangeLabel: nRangeLabelHtml('8–24'),
      exportFullerenePrefix: 'oct_fullerene_C',
      fullereneVertexCount: n => 2 * n + 8
    },
    ico: {
      key: 'ico', label: 'Icosahedral',
      nMin: 20, nMax: 60, nDefault: 20,
      poleDegree: 5, poleCount: 12, poleShapeName: 'pentagon',
      fullereneAvailable: true,
      table: () => window.CATALAN_TABLE,
      invalidTable: () => window.CATALAN_INVALID_TABLE,
      subtitleHtml: 'σ contracts the 12 pentagons of the icosahedral fullerene C<sub>2n+20</sub> to pole-vertices, producing its corresponding Catalan-like solid C(n)',
      nRangeLabel: nRangeLabelHtml('20–60'),
      exportFullerenePrefix: 'fullerene_C',
      fullereneVertexCount: n => 2 * n + 20
    }
  };
  const MODE_ORDER = ['tet', 'oct', 'ico'];
  const MODE_BUTTON_ID = { tet: 'modeTetBtn', oct: 'modeOctBtn', ico: 'modeIcoBtn' };

  const state = {
    mode: 'ico',
    n: 20,
    fullerene: null,          // reconstructed fullerene Poly, or null when unreconstructable
    contracted: null,         // {poly, mapping, counts, admissible, poleCount, keptCount, poleIndices, inv, fvC, fsv, sumCheck}
    contractedOn: false,      // are we currently showing C(n)?
    animating: false,
    invalid: null,            // null | {type: 'nonIsolatedPentagons'|'isolatedHexagons', m}
    highlightEdges: null,     // fullerene-view-only: [a,b] vertex pairs marking a pentagon-pentagon edge
    showDual: false,          // display the canonical dual of whichever poly (fullerene or C(n)) is selected
    geomVariant: 'canonical', // 'canonical' | 'optimized' -- sticky across n/mode/view changes
    optimizedCache: {},       // per-cell ('fullerene'|'fullereneDual'|'catalan'|'catalanDual') relaxed Poly, cleared on regenerate
    displayedInv: null,       // Geo.computeInvariants(...) of whatever's actually on screen right now (ρ/ι/ε rows)
    displayedFv: null,        // fVectorOf(...) of whatever's actually on screen right now
    displayedFsv: null,       // faceSizeVector(...) of whatever's actually on screen right now
    faceColorMode: 'shape',  // 'shape' | 'symmetry' | 'off' -- mutually exclusive, see tglColor/tglColorSymmetry
    lastSymmetryOrbits: null, // {orbitCount, orbitSizes, orbitAreas} of whatever's actually on screen, for the legend
    showAxes: false           // Stella-style symmetry-axis rods, see tglAxes
  };

  const $ = id => document.getElementById(id);
  const curMode = () => MODES[state.mode];

  // The true poles of a C(n)-like poly are exactly its degree-`poleDegree` vertices — this
  // must be computed from actual topology rather than assumed to be indices 0..(poleCount-1):
  // that range only holds for data we contracted ourselves (poleContract always pushes poles
  // first), not for published coordinate files, whose vertex order carries no such guarantee.
  //
  // This breaks down exactly when poleDegree is 3 (tetrahedral mode): "kept" vertices are
  // always degree 3 too (the underlying fullerene is trivalent throughout), so a degree scan
  // can't tell a pole from an ordinary vertex there — it finds every vertex, not just the 4
  // poles. explicitPoles (an entry's own "poles" list, present exactly when this ambiguity
  // applies) is used instead when given.
  function computePoleIndices(poly, poleDegree, explicitPoles) {
    if (explicitPoles) return explicitPoles.slice();
    const deg = new Array(poly.verts.length).fill(0);
    for (const f of poly.faces) for (const v of f) deg[v]++;
    const idx = [];
    for (let v = 0; v < poly.verts.length; v++) if (deg[v] === poleDegree) idx.push(v);
    return idx;
  }

  // Isolated hexagon faces in the fullerene view: a hexagon face is "isolated" iff none of
  // its vertices map to a pole in C(n) — i.e. it never touches any of the 12 pentagons.
  // Returns a Set of indices into state.fullerene.faces, for the fullerene-context magenta
  // highlight (C(n) context doesn't need this: every hexagon face there is isolated by
  // definition, since an admissible C(n) never has one at all).
  // poleIndices alone (degree-5 vertices) isn't enough here: a pentagon-pentagon-adjacent
  // isomer (n=21-24) has poles that lost a wedge to the shared edge and so aren't degree 5
  // anymore ("anomalousPoles"), but they're still poles — a hexagon touching only one of
  // those was being missed by poleIndices and wrongly read as isolated.
  function computeIsolatedHexFaceIndices() {
    if (!state.fullerene || !state.contracted) return new Set();
    const poleSet = new Set(state.contracted.poleIndices);
    for (const p of state.contracted.anomalousPoles || []) poleSet.add(p);
    const idx = new Set();
    state.fullerene.faces.forEach((f, fi) => {
      if (f.length === 6 && f.every(v => !poleSet.has(state.contracted.mapping[v]))) idx.add(fi);
    });
    return idx;
  }

  // Pole markers for the Fullerene's dual: Geo.computeDual builds dualVerts as
  // faces.map(...), so dual vertex index === original face index, one-for-one -- and
  // every fullerene pole is an entire pentagon/quad/triangle face (whichever shape
  // poleShapeName says), never a single vertex, so each pole face's dual point is exactly
  // one dual vertex. That gives the fullerene-dual context the same clean "pole = a vertex
  // I can drop a sphere on" property C(n) Primal already has, unlike C(n)'s OWN dual (there
  // a pole vertex fans out into a whole dual FACE, not a single vertex, so this doesn't
  // extend to that case). getOptimizedPoly's relax step only repositions vertices, never
  // reindexes, so these indices stay valid for the Optimized geometry too.
  function fullereneDualPoleIndices() {
    if (!state.fullerene) return null;
    const idx = [];
    state.fullerene.faces.forEach((f, fi) => { if (f.length !== 6) idx.push(fi); });
    return idx;
  }

  function fVectorOf(poly) {
    const V = poly.verts.length;
    const F = poly.faces.length;
    const seen = new Set();
    for (const f of poly.faces) {
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        seen.add(Math.min(a, b) + '_' + Math.max(a, b));
      }
    }
    return { V, E: seen.size, F };
  }

  function faceSizeVector(poly) {
    const m = {};
    for (const f of poly.faces) m[f.length] = (m[f.length] || 0) + 1;
    return m;
  }

  function invalidMsg(invalid) {
    if (!invalid) return '';
    const shape = curMode().poleShapeName;
    const label = invalid.type === 'nonIsolatedPentagons' ? `${shape}-${shape} edges` : 'isolated hexagons';
    return `no: ${label}: ${invalid.m}`;
  }

  // ---------------------------------------------------------------------------
  // Generation — load C(n) directly from the published, pre-solved coordinate
  // table (catalan_data.js / catalan_invalid_data.js), then reconstruct the
  // underlying fullerene by expanding each pole back into a pentagon (for the
  // "contract poles" toggle). Reconstruction is only attempted when every pole
  // is a normal degree-5 vertex — an "isolated hexagons" isomer still has 12 of
  // those, but a "non-isolated pentagons" one doesn't (two of its poles are
  // directly edge-adjacent to each other), so that case is shown as C(n) only.
  // ---------------------------------------------------------------------------
  function reasonForN(n) {
    const mode = curMode();
    if (mode.isImpossibleN && mode.isImpossibleN(n)) return mode.impossibleReason;
    const table = mode.table() || {};
    if (table[String(n)]) return '';
    const invalidTable = mode.invalidTable();
    if (invalidTable && invalidTable[String(n)]) return '';
    return 'No published coordinates for this n yet.';
  }

  function generate(n) {
    const mode = curMode();
    const table = mode.table() || {};
    const invalidTable = mode.invalidTable();
    const validEntry = table[String(n)];
    const invalidEntry = invalidTable && invalidTable[String(n)];
    const entry = validEntry || invalidEntry;
    if (!entry) {
      // reasonForN(n) is already shown in nMsg (setN runs before generate on every path
      // that reaches here) -- don't repeat it in genMsg too. Only the defensive fallback
      // (entry missing for some other reason) belongs here.
      const reason = reasonForN(n);
      setMsg(reason ? '' : `No data for n=${n}.`, !reason);
      return;
    }

    // Preserve whichever view (fullerene vs. contracted C(n)) the user was already looking
    // at — regenerating for a new n shouldn't silently kick them back to the fullerene view.
    const wantContracted = state.contractedOn;
    state.n = n;
    state.optimizedCache = {};

    if (invalidEntry && invalidEntry.isFullerene) {
      generateFromFullerene(n, invalidEntry, wantContracted);
      return;
    }

    const cVerts = entry.verts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const cPoly = { verts: cVerts, faces: entry.faces.map(f => f.slice()) };
    Geo.fixOrientationConsistency(cPoly);
    const inv = Geo.computeInvariants(cPoly);
    const fvC = fVectorOf(cPoly);
    const fsv = faceSizeVector(cPoly);
    const sumCheck = Object.entries(fsv).reduce((s, [k, v]) => s + (6 - Number(k)) * v, 0);
    const poleIndices = computePoleIndices(cPoly, mode.poleDegree, entry.poles);
    // Computed once from the canonical, published C(n) coordinates -- never a relaxed or
    // reconstructed variant -- so it's identical across Primal/Dual and
    // Canonical/Optimized (both preserve the underlying symmetry group). It is NOT
    // necessarily the same as the Fullerene's own symmetry, though -- pole contraction
    // can genuinely change the symmetry group, not just relabel it (confirmed on real
    // data: tetrahedral n=10's Fullerene is D2 but its C(n) is D4, a strictly larger,
    // different group) -- so that's computed and stored separately below.
    const catalanSymmetry = Geo.describeSymmetryGroup(cPoly);
    const contractedBase = {
      poly: cPoly, counts: countFaceTypes(cPoly), admissible: !invalidEntry,
      poleCount: poleIndices.length, keptCount: fvC.V - poleIndices.length, poleIndices, inv, fvC, fsv, sumCheck, catalanSymmetry
    };

    state.invalid = invalidEntry ? { type: invalidEntry.invalidType, m: invalidEntry.m } : null;
    state.highlightEdges = null;

    const attemptReconstruction = mode.fullereneAvailable && (!invalidEntry || invalidEntry.invalidType === 'isolatedHexagons');
    const exp = attemptReconstruction ? Geo.poleExpand(cPoly, { poleDegree: mode.poleDegree, expectedPoleCount: mode.poleCount, poles: entry.poles }) : null;

    if (exp && exp.ok) {
      const fullerene = exp.fullerene;
      Geo.fixOrientationConsistency(fullerene);
      Geo.canonicalize(fullerene, 5000, 1e-13);
      const fullMapping = new Array(fullerene.verts.length);
      for (const [oldV, newId] of exp.keepId) fullMapping[newId] = oldV;
      for (const P of exp.poles) for (const newId of exp.poleNewIds.get(P)) fullMapping[newId] = P;
      state.fullerene = fullerene;
      const fullereneSymmetry = Geo.describeSymmetryGroup(fullerene);
      state.contracted = Object.assign({ mapping: fullMapping, fullereneSymmetry }, contractedBase);
      // Admissibility (if any) is shown once, in the readout's "Admissible?" row — not here too.
      setMsg('', false);
      afterNewPoly(wantContracted);
    } else {
      // No fullerene reconstruction: either not attempted (non-isolated-pentagons —
      // the two anomalous poles can't be unambiguously expanded from contracted
      // data alone) or it unexpectedly failed. Show C(n) itself directly.
      state.fullerene = null;
      state.contracted = Object.assign({ mapping: null }, contractedBase);
      const msg = (exp && !exp.ok) ? 'Pole expansion failed: ' + exp.msg : '';
      setMsg(msg, !!msg);
      afterNewPoly(true);
    }
  }

  // Entries stored as raw fullerene data (currently just non-isolated-pentagons isomers):
  // contract forward via poleContract, which handles pentagon-pentagon adjacency directly
  // and hands back both the C(n) result and the fullerene<->C(n) vertex mapping, so the
  // "contract poles" toggle works exactly as it does for admissible isomers.
  function generateFromFullerene(n, entry, wantContracted) {
    state.optimizedCache = {};
    const fVerts = entry.verts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const fullerene = { verts: fVerts, faces: entry.faces.map(f => f.slice()) };
    Geo.fixOrientationConsistency(fullerene);
    Geo.canonicalize(fullerene, 5000, 1e-13);

    const mode = curMode();
    const cr = Geo.poleContract(fullerene, { poleDegree: mode.poleDegree, expectedPoleCount: mode.poleCount });
    if (!cr.ok) { setMsg('Pole contraction failed: ' + cr.msg, true); return; }
    Geo.canonicalize(cr.poly, 20000, 1e-13);

    const inv = Geo.computeInvariants(cr.poly);
    const fvC = fVectorOf(cr.poly);
    const fsv = faceSizeVector(cr.poly);
    const sumCheck = Object.entries(fsv).reduce((s, [k, v]) => s + (6 - Number(k)) * v, 0);
    // Computed separately -- pole contraction can genuinely change the symmetry group,
    // not just relabel it (see the matching comment in generate()).
    const catalanSymmetry = Geo.describeSymmetryGroup(cr.poly);
    const fullereneSymmetry = Geo.describeSymmetryGroup(fullerene);

    state.invalid = { type: entry.invalidType, m: cr.nonIsolatedPentagonPairs || cr.isolatedHexagonCount };
    state.highlightEdges = cr.nonIsolatedPentagonEdges;
    state.fullerene = fullerene;
    state.contracted = {
      poly: cr.poly, mapping: cr.mapping, counts: cr.counts, admissible: cr.admissible,
      poleCount: cr.poleCount, keptCount: cr.keptCount, catalanSymmetry, fullereneSymmetry,
      // cr.poly is freshly contracted by Geo.poleContract, which (like our own offline
      // pole_contract) always pushes poles first, so indices 0..poleCount-1 are exact —
      // no degree scan needed (and none would work for poleDegree 3 anyway).
      poleIndices: Array.from({ length: cr.poleCount }, (_, i) => i),
      anomalousPoles: cr.anomalousPoles || [], inv, fvC, fsv, sumCheck
    };
    // Admissibility (if any) is shown once, in the readout's "Admissible?" row — not here too.
    setMsg('', false);
    afterNewPoly(wantContracted);
  }

  function countFaceTypes(poly) {
    const c = { a3: 0, a4: 0, a5: 0, other: 0 };
    for (const f of poly.faces) {
      if (f.length === 3) c.a3++; else if (f.length === 4) c.a4++; else if (f.length === 5) c.a5++; else c.other++;
    }
    return c;
  }

  function setMsg(msg, isErr) {
    const el = $('genMsg');
    el.textContent = msg;
    el.className = 'msg' + (isErr ? ' err' : '');
  }

  // Renders whatever poly the current state (contractedOn + showDual) selects. Centralized
  // so the dual toggle doesn't have to duplicate the fullerene-vs-C(n) branch, and so both
  // land on identical behavior. Pole markers, the pentagon/quad-pentagon defect-edge
  // highlight, and the isolated-hexagon highlight are all indexed into the *original*
  // poly's vertices/faces, which don't correspond to anything on its dual (dual vertices
  // are original faces, dual faces are original vertices) — so all three are dropped
  // whenever showDual is on; only the shape-based face coloring (which needs nothing but
  // face size) carries over, via the ordinary non-fullerene-context classification.
  function currentPoly() {
    return state.contractedOn ? state.contracted.poly : state.fullerene;
  }

  // fixOrientationConsistency is run here as a defensive measure, matching every other
  // poly-producing operation in this codebase (poleExpand, poleContract, raw loads all do
  // the same) — computeDual's own face-tracing is already orientation-correct given a
  // consistently-wound input, but this costs nothing and hardens against any residual edge
  // case rather than relying solely on that.
  function dualOf(poly) {
    const dual = Geo.computeDual(poly);
    Geo.fixOrientationConsistency(dual);
    return dual;
  }

  function clonePoly(poly) {
    return { verts: poly.verts.map(v => v.clone()), faces: poly.faces.map(f => f.slice()) };
  }

  // Which of the 4 view-state cells (Fullerene / dual-of-Fullerene / Catalan-like C(n) /
  // dual-of-C(n)) is currently active -- each gets its own Optimized relaxation objective
  // and its own optimizedCache slot.
  function currentCellKey() {
    return state.contractedOn
      ? (state.showDual ? 'catalanDual' : 'catalan')
      : (state.showDual ? 'fullereneDual' : 'fullerene');
  }

  // The poly renderCurrentPoly() would draw if geomVariant were 'canonical', regardless of
  // what it actually is right now -- used both as the relaxation seed and as one endpoint
  // of the canonical<->optimized morph.
  function canonicalRenderedPoly() {
    const base = currentPoly();
    return state.showDual ? dualOf(base) : base;
  }

  // Lazily relax the current cell's own geometry toward its per-cell objective (see
  // geometry.js's relaxFullerene/relaxDualOfFullerene/relaxEqualizeFaceAreas/
  // relaxDualOfCatalan), caching the result per cell until the next generate() invalidates
  // it. The two dual cells relax the *dual* polyhedron itself, computed from the
  // already-canonical primal first -- never the other way around, since computeDual's
  // polar-reciprocal math requires a midsphere-canonical input to mean anything.
  function getOptimizedPoly(key) {
    if (!state.contracted) return null;
    key = key || currentCellKey();
    if (state.optimizedCache[key]) return state.optimizedCache[key];
    let poly = null;
    if (key === 'catalan') {
      poly = clonePoly(state.contracted.poly);
      Geo.relaxEqualizeFaceAreas(poly);
    } else if (key === 'catalanDual') {
      poly = dualOf(state.contracted.poly);
      Geo.relaxDualOfCatalan(poly);
    } else if (state.fullerene) {
      if (key === 'fullerene') {
        poly = clonePoly(state.fullerene);
        Geo.relaxFullerene(poly);
      } else {
        poly = dualOf(state.fullerene);
        Geo.relaxDualOfFullerene(poly);
      }
    }
    if (poly) state.optimizedCache[key] = poly;
    return poly;
  }

  // The dual of an octahedral-mode C(n) has quads that read as slight trapezoids under the
  // ordinary shape check, but should be shown as rhombi (red) regardless — except at n=9 and
  // n=10, whose dual quads are genuinely trapezoids (green) and should keep that coloring.
  function dualQuadsForceRhombus() {
    return state.mode === 'oct' && state.contractedOn && state.n !== 9 && state.n !== 10;
  }

  // "Color faces by symmetry" needs the group-detection + face-orbit-matching pass,
  // which is too costly to run every animation frame (see setPoly call sites during
  // morphs, which pass no explicitColors at all and so fall back to plain shape
  // classification for the ~0.5s a transition is on screen) -- it's only computed here,
  // once per settled poly, and its result baked into the geometry via explicitColors.
  function symmetryColorsFor(poly) {
    const orbits = Geo.computeFaceSymmetryOrbits(poly);
    state.lastSymmetryOrbits = orbits;
    return orbits.orbitIndex.map(rank => Renderer.colorForSymmetryRank(rank));
  }

  function renderCurrentPoly() {
    const optimized = state.geomVariant === 'optimized' ? getOptimizedPoly() : null;
    const rendered = optimized || canonicalRenderedPoly();
    const symColors = state.faceColorMode === 'symmetry' ? symmetryColorsFor(rendered) : undefined;
    if (state.showDual) {
      const poleIdx = state.contractedOn ? null : fullereneDualPoleIndices();
      Renderer.setPoly(rendered, poleIdx, false, null, null, symColors, dualQuadsForceRhombus());
    } else if (state.contractedOn) {
      Renderer.setPoly(rendered, state.contracted.poleIndices, false, null, null, symColors);
    } else {
      Renderer.setPoly(rendered, null, true, state.highlightEdges, computeIsolatedHexFaceIndices(), symColors);
    }
    // ρ/ι/ε and the f-vector / face-size vector all reflect whatever's actually on
    // screen -- Fullerene, C(n), or either's dual, canonical or Optimized.
    state.displayedInv = Geo.computeInvariants(rendered);
    state.displayedFv = fVectorOf(rendered);
    state.displayedFsv = faceSizeVector(rendered);
    if (state.faceColorMode === 'symmetry') renderLegend();
    // Axis rods aren't part of the face geometry -- rebuilt separately, only when actually
    // shown (group-detection is the same non-per-frame-affordable cost symmetry coloring
    // has), so they always match whatever poly just landed on screen.
    if (state.showAxes) Renderer.setAxes(rendered, Geo.computeSymmetryAxes(rendered));
  }

  function afterNewPoly(showContracted) {
    state.contractedOn = showContracted;
    renderCurrentPoly();
    updateViewButtons();
    updateReadout();
  }

  // ---------------------------------------------------------------------------
  // Pole-contraction animation — driven by the two view buttons (Fullerene /
  // Contract poles) rather than a single toggle, so each is a direct "go to this
  // view" request instead of a relative flip.
  // ---------------------------------------------------------------------------
  function setView(wantContracted) {
    if (!state.contracted || state.animating) return;
    if (wantContracted === state.contractedOn) return;
    if (!wantContracted && !state.fullerene) return; // no fullerene data to show in this mode/isomer

    // Fullerene-dual and C(n)-dual have different vertex counts, but a well-defined
    // correspondence still exists: pole contraction never touches non-pole faces, so
    // their duals share index-aligned vertices for every non-pole face, and each of
    // Fullerene-dual's extra vertices is the apex of a kis split of exactly one pole
    // face of C(n)-dual (see Geo.buildDualMorphEndpoints). That makes this an ordinary
    // per-vertex lerp too, reading as pyramids growing out of / collapsing into C(n)-dual's
    // pole faces, instead of an instant cut.
    if (state.showDual) {
      const optimized = state.geomVariant === 'optimized';
      const catalanDual = optimized ? getOptimizedPoly('catalanDual') : dualOf(state.contracted.poly);
      const fullereneDual = optimized ? getOptimizedPoly('fullereneDual') : dualOf(state.fullerene);
      const Fc = state.contracted.poly.faces.length;
      const kisCatalanDual = Geo.buildDualMorphEndpoints(
        catalanDual, fullereneDual, state.fullerene, state.contracted.mapping, Fc);

      const turningOn = wantContracted;
      const fromPoly = turningOn ? fullereneDual : kisCatalanDual;
      const toPoly = turningOn ? kisCatalanDual : fullereneDual;
      const forceRhombusQuads = dualQuadsForceRhombus();

      state.animating = true;
      const duration = 600;
      const t0 = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - t0) / duration);
        const te = t * t * (3 - 2 * t); // smoothstep
        const nv = fromPoly.verts.length;
        const lerped = new Array(nv);
        for (let i = 0; i < nv; i++) lerped[i] = new THREE.Vector3().lerpVectors(fromPoly.verts[i], toPoly.verts[i], te);
        Renderer.setPoly({ verts: lerped, faces: toPoly.faces }, null, false, null, null, undefined, forceRhombusQuads);
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          state.animating = false;
          state.contractedOn = turningOn;
          renderCurrentPoly();
          updateViewButtons();
          updateReadout();
        }
      }
      requestAnimationFrame(frame);
      return;
    }

    const turningOn = wantContracted;
    state.animating = true;
    const duration = 600;
    const t0 = performance.now();

    // Animate between whichever geometry is actually on screen -- canonical or Optimized
    // -- rather than always the canonical data, so an Optimized shape doesn't pop to a
    // different (canonical) one right as the animation completes. Both getOptimizedPoly
    // results preserve state.fullerene's / state.contracted.poly's own vertex order (they
    // only reposition vertices, never reindex), so `mapping` still applies unchanged.
    const optimized = state.geomVariant === 'optimized';
    const fullSource = optimized ? getOptimizedPoly('fullerene') : state.fullerene;
    const catalanSource = optimized ? getOptimizedPoly('catalan') : state.contracted.poly;

    const nFull = state.fullerene.verts.length;
    const fromPositions = fullSource.verts.map(v => v.clone());
    const targetPositions = new Array(nFull);
    for (let i = 0; i < nFull; i++) {
      const mapped = state.contracted.mapping[i];
      targetPositions[i] = catalanSource.verts[mapped].clone();
    }
    const baseFaces = state.fullerene.faces;

    function frame(now) {
      let t = Math.min(1, (now - t0) / duration);
      const te = t * t * (3 - 2 * t); // smoothstep
      const tt = turningOn ? te : 1 - te;
      Renderer.renderMorphFrame(baseFaces, fromPositions, targetPositions, tt);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        state.animating = false;
        state.contractedOn = turningOn;
        renderCurrentPoly();
        updateViewButtons();
        updateReadout();
      }
    }
    requestAnimationFrame(frame);
  }

  function updateViewButtons() {
    const fullereneBtn = $('viewFullereneBtn');
    const contractedBtn = $('viewContractedBtn');
    fullereneBtn.disabled = !state.fullerene;
    if (!state.fullerene) {
      const shape = curMode().poleShapeName;
      fullereneBtn.title = !curMode().fullereneAvailable
        ? `Fullerene reconstruction data isn't available yet for ${curMode().label.toLowerCase()} mode.`
        : (state.invalid && state.invalid.type === 'nonIsolatedPentagons'
          ? `Fullerene reconstruction isn't available for this non-IPR isomer — the two adjacent ${shape} poles can't be unambiguously expanded back from the contracted data alone.`
          : '');
    } else {
      fullereneBtn.title = '';
    }
    contractedBtn.disabled = false;
    contractedBtn.title = '';
    fullereneBtn.classList.toggle('active', !state.contractedOn);
    contractedBtn.classList.toggle('active', state.contractedOn);
    $('primalBtn').classList.toggle('active', !state.showDual);
    $('dualBtn').classList.toggle('active', state.showDual);
    updateOptimizedButton();
  }

  // Expansion-style dual morph: every original face shrinks toward its one dual vertex while
  // a new face grows at every original vertex out to the dual vertices around it, simultaneously
  // — see Renderer.renderDualMorphFrame's own comment for the full construction. Computed once
  // up front (not per frame) since it depends only on the poly being toggled, not on t.
  function setDualView(wantDual) {
    if (!state.contracted || state.animating) return;
    if (wantDual === state.showDual) return;
    const turningOn = wantDual;
    // Same reasoning as setView: animate whichever geometry is actually on screen (canonical
    // or Optimized) so the shape doesn't pop to a different one right as the morph finishes.
    // getOptimizedPoly's dual cells are already built as dualOf(canonical primal) + relax, so
    // they share buildTruncationMorphPoly's required face/vertex correspondence with `base`.
    const optimized = state.geomVariant === 'optimized';
    const primalKey = state.contractedOn ? 'catalan' : 'fullerene';
    const dualKey = state.contractedOn ? 'catalanDual' : 'fullereneDual';
    const base = optimized ? getOptimizedPoly(primalKey) : currentPoly();
    const dual = optimized ? getOptimizedPoly(dualKey) : dualOf(base);
    // Matches the classification args renderCurrentPoly() would use for `base` itself, so a
    // shrinking face reads exactly as it would in the static (non-dual) view it came from.
    const isFullereneCtx = !state.contractedOn;
    const isolatedHexFaceIndices = isFullereneCtx ? computeIsolatedHexFaceIndices() : null;
    const forceRhombusQuads = dualQuadsForceRhombus();
    state.animating = true;
    const duration = 600;
    const t0 = performance.now();

    function frame(now) {
      let t = Math.min(1, (now - t0) / duration);
      const te = t * t * (3 - 2 * t); // smoothstep
      const tt = turningOn ? te : 1 - te;
      Renderer.renderDualMorphFrame(base, dual.verts, dual.faces, tt, isFullereneCtx, isolatedHexFaceIndices, forceRhombusQuads);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        state.animating = false;
        state.showDual = turningOn;
        renderCurrentPoly();
        updateViewButtons();
        updateReadout();
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Canonical / Optimized — relaxes the *currently displayed* cell's own geometry
  // toward its per-cell objective (see getOptimizedPoly / geometry.js's relax*
  // wrappers) and morphs to it, the same way setView/setDualView morph between their
  // two states. Canonical and Optimized always share identical face/vertex-index
  // structure for the active cell (relaxation only repositions vertices), so a plain
  // per-vertex lerp is exact — no truncation-style morph needed here.
  // ---------------------------------------------------------------------------
  const OPTIMIZED_OBJECTIVE = {
    fullerene: 'Equalize edge lengths (convex)',
    fullereneDual: 'Equalize edge lengths (concavity allowed)',
    catalan: 'Equalize face areas',
    catalanDual: 'Regularize faces: equal edges + angles (convex)'
  };

  // Cheap availability check (no relaxation run) -- the only cell that can't be optimized
  // is one of the two fullerene-based cells when no fullerene reconstruction exists.
  function cellCanOptimize() {
    const key = currentCellKey();
    return key === 'catalan' || key === 'catalanDual' || !!state.fullerene;
  }

  function updateOptimizedButton() {
    const canonicalBtn = $('canonicalBtn'), optimizedBtn = $('optimizedBtn');
    if (!canonicalBtn || !optimizedBtn) return;
    const available = cellCanOptimize();
    optimizedBtn.disabled = !available;
    optimizedBtn.title = available
      ? OPTIMIZED_OBJECTIVE[currentCellKey()]
      : 'No fullerene reconstruction is available to relax in this cell.';
    canonicalBtn.classList.toggle('active', state.geomVariant !== 'optimized' || !available);
    optimizedBtn.classList.toggle('active', state.geomVariant === 'optimized' && available);
  }

  function setGeomVariant(wantOptimized) {
    if (!state.contracted || state.animating) return;
    if (wantOptimized === (state.geomVariant === 'optimized')) return;
    const optimized = wantOptimized ? getOptimizedPoly() : null;
    if (wantOptimized && !optimized) return; // e.g. no fullerene reconstruction to relax in this cell

    const canonical = canonicalRenderedPoly();
    const cached = wantOptimized ? optimized : getOptimizedPoly();
    const fromPoly = wantOptimized ? canonical : cached;
    const toPoly = wantOptimized ? cached : canonical;

    const isFullereneCtx = !state.contractedOn && !state.showDual;
    const poleIndices = (state.contractedOn && !state.showDual) ? state.contracted.poleIndices
      : (!state.contractedOn && state.showDual) ? fullereneDualPoleIndices() : null;
    const highlightEdges = isFullereneCtx ? state.highlightEdges : null;
    const isolatedHexFaceIndices = isFullereneCtx ? computeIsolatedHexFaceIndices() : null;
    const forceRhombusQuads = dualQuadsForceRhombus();
    const baseFaces = toPoly.faces;
    const fromPositions = fromPoly.verts, targetPositions = toPoly.verts;

    state.animating = true;
    const duration = 500;
    const t0 = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - t0) / duration);
      const te = t * t * (3 - 2 * t); // smoothstep
      const n = fromPositions.length;
      const lerped = new Array(n);
      for (let i = 0; i < n; i++) lerped[i] = new THREE.Vector3().lerpVectors(fromPositions[i], targetPositions[i], te);
      Renderer.setPoly({ verts: lerped, faces: baseFaces }, poleIndices, isFullereneCtx, highlightEdges, isolatedHexFaceIndices, undefined, forceRhombusQuads);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        state.animating = false;
        state.geomVariant = wantOptimized ? 'optimized' : 'canonical';
        renderCurrentPoly();
        updateOptimizedButton();
        updateReadout();
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Readout
  // ---------------------------------------------------------------------------
  function fmtHit(val, digits) {
    const s = val.toFixed(digits);
    const hit = Math.abs(val - 1) < 5e-7;
    return `<span class="v${hit ? ' hit' : ''}">${s}</span>`;
  }

  function updateReadout() {
    const el = $('readout');
    if (!state.contracted) { el.innerHTML = ''; return; }
    const n = state.n;
    let lines = [];
    lines.push(row('n:', n));
    const c = state.contracted;
    // f-vector and face-size vector, like ρ/ι/ε, describe whatever's actually on screen
    // right now -- Fullerene, C(n), or either's dual, canonical or Optimized.
    const dispFv = state.displayedFv || c.fvC;
    lines.push(row('f-vector:', `(${dispFv.V},${dispFv.E},${dispFv.F})`));
    const dispFsv = state.displayedFsv || c.fsv;
    const fsvStr = Object.keys(dispFsv).sort().map(k => `${k}:${dispFsv[k]}`).join(', ');
    lines.push(row('Face-size vector:', `{${fsvStr}}`));
    // Symmetry is constant across Primal/Dual and Canonical/Optimized (both preserve the
    // underlying symmetry group) but NOT across Fullerene vs. C(n) -- pole contraction can
    // genuinely change the symmetry group, not just relabel it (confirmed on real data:
    // tetrahedral n=10 is D2 as a Fullerene but D4 as C(n)) -- so it switches with
    // state.contractedOn, same as the view itself, while staying fixed across the other
    // two axes. Falls back to catalanSymmetry when there's no Fullerene reconstruction to
    // have its own value (e.g. non-isolated-pentagon isomers).
    const symmetry = (state.contractedOn || !c.fullereneSymmetry) ? c.catalanSymmetry : c.fullereneSymmetry;
    lines.push(row('Symmetry:', symmetry.label));
    const dispInv = state.displayedInv || c.inv;
    lines.push(rowHtml('ρ (rho):', fmtHit(dispInv.rho, 6)));
    lines.push(rowHtml('ι (iota):', fmtHit(dispInv.iota, 4)));
    lines.push(rowHtml('ε (epsilon):', fmtHit(dispInv.edgeRatio, 4)));
    if (state.invalid) {
      lines.push(rowHtml('Admissible?', `<span class="v" style="color:var(--danger);font-weight:700;">${invalidMsg(state.invalid)}</span>`));
    } else {
      lines.push(rowHtml('Admissible?', `<span class="v" style="color:var(--ok);font-weight:700;">yes</span>`));
    }
    el.innerHTML = lines.join('');
  }
  function row(k, v) { return `<div><span class="k">${k}</span><span class="v">${v}</span></div>`; }
  function rowHtml(k, vHtml) { return `<div><span class="k">${k}</span>${vHtml}</div>`; }

  // ---------------------------------------------------------------------------
  // n input / availability
  // ---------------------------------------------------------------------------
  function updateNAvailability() {
    const n = state.n;
    const reason = reasonForN(n);
    $('nMsg').textContent = reason;
    $('nMsg').className = 'msg' + (reason ? ' err' : '');
  }

  function setN(n) {
    const mode = curMode();
    n = Math.max(mode.nMin, Math.min(mode.nMax, Math.round(n)));
    state.n = n;
    $('nSlider').value = n;
    $('nInput').value = n;
    updateNAvailability();
  }

  // ---------------------------------------------------------------------------
  // Symmetry mode switching
  // ---------------------------------------------------------------------------
  function switchMode(modeKey) {
    if (state.mode === modeKey || state.animating) return;
    state.mode = modeKey;
    const mode = curMode();
    for (const key of MODE_ORDER) $(MODE_BUTTON_ID[key]).classList.toggle('active', key === modeKey);
    $('modeSubtitle').innerHTML = mode.subtitleHtml;
    $('nRangeLabel').innerHTML = mode.nRangeLabel;
    $('nSlider').min = mode.nMin; $('nSlider').max = mode.nMax;
    $('nInput').min = mode.nMin; $('nInput').max = mode.nMax;
    $('polesLabel').textContent = `Mark poles (deg-${mode.poleDegree})`;
    renderLegend();
    // Default to the base fullerene in every mode, matching the initial (icosahedral) load —
    // generate() falls back to Contracted C(n) on its own if reconstruction isn't available.
    state.contractedOn = false;
    setN(mode.nDefault);
    generate(mode.nDefault);
  }

  // ---------------------------------------------------------------------------
  // OFF export
  // ---------------------------------------------------------------------------
  function exportOFF() {
    const base = currentPoly();
    if (!base) return;
    const optimized = state.geomVariant === 'optimized' ? getOptimizedPoly() : null;
    const poly = optimized || (state.showDual ? dualOf(base) : base);
    let lines = ['OFF', `${poly.verts.length} ${poly.faces.length} 0`];
    for (const v of poly.verts) lines.push(`${v.x.toFixed(10)} ${v.y.toFixed(10)} ${v.z.toFixed(10)}`);
    for (const f of poly.faces) lines.push(`${f.length} ${f.join(' ')}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = $('exportLink');
    a.href = url;
    const baseName = state.contractedOn ? 'C' + state.n : curMode().exportFullerenePrefix + curMode().fullereneVertexCount(state.n);
    const dualName = state.showDual ? 'dual_' + baseName : baseName;
    a.download = `${optimized ? dualName + '_optimized' : dualName}.off`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  function swatchRow(hex, label, opts) {
    opts = opts || {};
    const col = '#' + hex.toString(16).padStart(6, '0');
    const h = opts.line ? '2px' : '10px';
    const mb = opts.line ? 'margin-bottom:4px;' : '';
    const border = opts.line ? '' : 'border:1px solid var(--border);';
    return `<div><span style="display:inline-block;width:10px;height:${h};background:${col};${border}margin-right:6px;${mb}vertical-align:middle;"></span>${label}</div>`;
  }

  function renderShapeLegend() {
    const shape = curMode().poleShapeName;
    const labels = {
      triangle: 'triangle', rhombus: 'rhombus/near-rhombus', trapezoid: 'trapezoid/skew quadrilateral',
      floretPentagon: 'floret pentagon',
      fullereneHexagon: 'hexagon (fullerene)', fullerenePoleFace: `pole ${shape} (fullerene)`,
      error: 'isolated hexagon (error)'
    };
    const rows = Object.entries(Renderer.FACE_COLORS).map(([key, hex]) => swatchRow(hex, labels[key] || key));
    rows.push(swatchRow(0xd633c4, `${shape}-${shape} edge (error)`, { line: true }));
    $('legend').innerHTML = rows.join('');
  }

  // Dynamic, per-solid legend: one swatch per genuine symmetry orbit found by
  // Geo.computeFaceSymmetryOrbits, in the same largest-area-first priority order the
  // colors themselves are assigned in -- unlike the fixed shape legend, this one only
  // makes sense once a poly has actually been classified (see state.lastSymmetryOrbits,
  // set by symmetryColorsFor in renderCurrentPoly).
  function renderSymmetryLegend() {
    const orbits = state.lastSymmetryOrbits;
    if (!orbits) { $('legend').innerHTML = ''; return; }
    const rows = orbits.orbitSizes.map((size, rank) => {
      const label = `class ${rank + 1} — ${size} face${size === 1 ? '' : 's'}, area ${orbits.orbitAreas[rank].toFixed(4)}`;
      return swatchRow(Renderer.colorForSymmetryRank(rank), label);
    });
    $('legend').innerHTML = rows.join('');
  }

  function renderLegend() {
    if (state.faceColorMode === 'symmetry') renderSymmetryLegend();
    else renderShapeLegend();
  }

  function main() {
    if (!Renderer.init($('c'))) {
      $('webglError').style.display = 'flex';
      return;
    }
    renderLegend();

    $('nSlider').addEventListener('input', e => setN(+e.target.value));
    $('nSlider').addEventListener('change', () => generate(state.n));
    $('nInput').addEventListener('change', e => { setN(+e.target.value); generate(state.n); });

    // Left/Right arrow keys step n by 1 and generate immediately, from anywhere on the
    // page — except while the number input has focus, where they should still move the
    // text cursor rather than being hijacked. Steps past any n a mode marks as provably
    // impossible (not just unpublished) rather than landing on it — e.g. tetrahedral mode's
    // odd n, which no (3,6)-fullerene can realize at all. Starting from an impossible n
    // itself (typed in directly) still moves toward the nearest possible one, not just ±1.
    document.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (document.activeElement === $('nInput')) return;
      e.preventDefault();
      const mode = curMode();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      let next = state.n + dir;
      while (next >= mode.nMin && next <= mode.nMax && mode.isImpossibleN && mode.isImpossibleN(next)) next += dir;
      setN(next);
      generate(state.n);
    });
    for (const key of MODE_ORDER) $(MODE_BUTTON_ID[key]).addEventListener('click', () => switchMode(key));
    $('viewFullereneBtn').addEventListener('click', () => setView(false));
    $('viewContractedBtn').addEventListener('click', () => setView(true));
    $('primalBtn').addEventListener('click', () => setDualView(false));
    $('dualBtn').addEventListener('click', () => setDualView(true));
    $('canonicalBtn').addEventListener('click', () => setGeomVariant(false));
    $('optimizedBtn').addEventListener('click', () => setGeomVariant(true));
    $('exportBtn').addEventListener('click', exportOFF);

    $('tglColor').addEventListener('change', e => {
      const on = e.target.checked;
      const wasSymmetry = state.faceColorMode === 'symmetry';
      state.faceColorMode = on ? 'shape' : 'off';
      if (on) $('tglColorSymmetry').checked = false;
      Renderer.setToggles({ color: on, symmetryColor: false });
      // Only needs a full rebuild coming FROM symmetry mode: its geometry has symmetry
      // colors baked into the vertex-color attribute itself (not just a material flag),
      // which flipping vertexColors back on would otherwise still show unchanged.
      if (wasSymmetry) renderCurrentPoly();
      renderLegend(); // switches the legend back to the fixed shape one (renderCurrentPoly only refreshes it for 'symmetry' mode)
    });
    $('tglColorSymmetry').addEventListener('change', e => {
      const on = e.target.checked;
      state.faceColorMode = on ? 'symmetry' : 'off';
      if (on) $('tglColor').checked = false;
      Renderer.setToggles({ color: false, symmetryColor: on });
      renderCurrentPoly(); // symmetry colors are baked into the geometry, not just a material flag -- needs a rebuild
      renderLegend(); // covers turning symmetry OFF, which renderCurrentPoly's own legend refresh doesn't reach
    });
    $('tglEdges').addEventListener('change', e => { Renderer.setToggles({ edges: e.target.checked }); });
    $('tglSphere').addEventListener('change', e => { Renderer.setToggles({ sphere: e.target.checked }); });
    $('tglPoles').addEventListener('change', e => { Renderer.setToggles({ poles: e.target.checked }); });
    $('tglAxes').addEventListener('change', e => {
      state.showAxes = e.target.checked;
      Renderer.setToggles({ axes: state.showAxes });
      // Turning on needs an actual build (setToggles only flips visibility) -- off just
      // hides the already-built rods, which renderCurrentPoly will refresh next time it
      // runs anyway.
      if (state.showAxes) renderCurrentPoly();
    });
    $('tglIsolatedHex').addEventListener('change', e => { Renderer.setToggles({ highlightIsolatedHex: e.target.checked }); });
    $('tglSpin').addEventListener('change', e => { Renderer.setToggles({ spin: e.target.checked }); });

    setN(20);
    generate(20);

    Renderer.startLoop(() => {
      if (!state.contracted) { $('hud').textContent = ''; return; }
      const baseLabel = state.contractedOn
        ? `${curMode().label} Catalan-like solid C(${state.n})`
        : `${curMode().label} C${curMode().fullereneVertexCount(state.n)} fullerene`;
      const label = state.showDual ? `Dual of ${baseLabel}` : baseLabel;
      $('hud').textContent = `${label} — drag to orbit, scroll to zoom`;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main); else main();
})();

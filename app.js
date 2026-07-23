// ===================================================================================
// app.js — UI wiring, state. No build step; everything lives in memory.
// ===================================================================================
(function () {
  'use strict';

  const state = {
    n: 20,
    fullerene: null,          // reconstructed fullerene Poly, or null when unreconstructable
    contracted: null,         // {poly, mapping, counts, admissible, poleCount, keptCount, poleIndices, inv, fvC, fsv, sumCheck}
    contractedOn: false,      // are we currently showing C(n)?
    animating: false,
    invalid: null,            // null | {type: 'nonIsolatedPentagons'|'isolatedHexagons', m}
    highlightEdges: null      // fullerene-view-only: [a,b] vertex pairs marking a pentagon-pentagon edge
  };

  const $ = id => document.getElementById(id);

  // The true poles of a C(n)-like poly are exactly its degree-5 vertices — this must be
  // computed from actual topology rather than assumed to be indices 0..11: that range only
  // holds for data we contracted ourselves (poleContract always pushes poles first), not for
  // published coordinate files, whose vertex order carries no such guarantee.
  function computePoleIndices(poly) {
    const deg = new Array(poly.verts.length).fill(0);
    for (const f of poly.faces) for (const v of f) deg[v]++;
    const idx = [];
    for (let v = 0; v < poly.verts.length; v++) if (deg[v] === 5) idx.push(v);
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
    const label = invalid.type === 'nonIsolatedPentagons' ? 'pentagon-pentagon edges' : 'isolated hexagons';
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
    if (window.CATALAN_TABLE[String(n)]) return '';
    if (window.CATALAN_INVALID_TABLE && window.CATALAN_INVALID_TABLE[String(n)]) return '';
    return 'No published coordinates for this n yet.';
  }

  function generate(n) {
    const validEntry = window.CATALAN_TABLE[String(n)];
    const invalidEntry = window.CATALAN_INVALID_TABLE && window.CATALAN_INVALID_TABLE[String(n)];
    const entry = validEntry || invalidEntry;
    if (!entry) { setMsg(reasonForN(n) || `No data for n=${n}.`, true); return; }

    state.n = n;

    if (invalidEntry && invalidEntry.isFullerene) {
      generateFromFullerene(n, invalidEntry);
      return;
    }

    const cVerts = entry.verts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const cPoly = { verts: cVerts, faces: entry.faces.map(f => f.slice()) };
    Geo.fixOrientationConsistency(cPoly);
    const inv = Geo.computeInvariants(cPoly);
    const fvC = fVectorOf(cPoly);
    const fsv = faceSizeVector(cPoly);
    const sumCheck = Object.entries(fsv).reduce((s, [k, v]) => s + (6 - Number(k)) * v, 0);
    const poleIndices = computePoleIndices(cPoly);
    const contractedBase = {
      poly: cPoly, counts: countFaceTypes(cPoly), admissible: !invalidEntry,
      poleCount: 12, keptCount: fvC.V - 12, poleIndices, inv, fvC, fsv, sumCheck
    };

    state.invalid = invalidEntry ? { type: invalidEntry.invalidType, m: invalidEntry.m } : null;
    state.highlightEdges = null;

    const attemptReconstruction = !invalidEntry || invalidEntry.invalidType === 'isolatedHexagons';
    const exp = attemptReconstruction ? Geo.poleExpand(cPoly) : null;

    if (exp && exp.ok) {
      const fullerene = exp.fullerene;
      Geo.fixOrientationConsistency(fullerene);
      Geo.canonicalize(fullerene, 5000, 1e-13);
      const fullMapping = new Array(fullerene.verts.length);
      for (const [oldV, newId] of exp.keepId) fullMapping[newId] = oldV;
      for (const P of exp.poles) for (const newId of exp.poleNewIds.get(P)) fullMapping[newId] = P;
      state.fullerene = fullerene;
      state.contracted = Object.assign({ mapping: fullMapping }, contractedBase);
      setMsg(invalidMsg(state.invalid), !!state.invalid);
      afterNewPoly(false);
    } else {
      // No fullerene reconstruction: either not attempted (non-isolated-pentagons —
      // the two anomalous poles can't be unambiguously expanded from contracted
      // data alone) or it unexpectedly failed. Show C(n) itself directly.
      state.fullerene = null;
      state.contracted = Object.assign({ mapping: null }, contractedBase);
      const msg = invalidMsg(state.invalid) || (exp && !exp.ok ? 'Pole expansion failed: ' + exp.msg : '');
      setMsg(msg, true);
      afterNewPoly(true);
    }
  }

  // Entries stored as raw fullerene data (currently just non-isolated-pentagons isomers):
  // contract forward via poleContract, which handles pentagon-pentagon adjacency directly
  // and hands back both the C(n) result and the fullerene<->C(n) vertex mapping, so the
  // "contract poles" toggle works exactly as it does for admissible isomers.
  function generateFromFullerene(n, entry) {
    const fVerts = entry.verts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const fullerene = { verts: fVerts, faces: entry.faces.map(f => f.slice()) };
    Geo.fixOrientationConsistency(fullerene);
    Geo.canonicalize(fullerene, 5000, 1e-13);

    const cr = Geo.poleContract(fullerene);
    if (!cr.ok) { setMsg('Pole contraction failed: ' + cr.msg, true); return; }
    Geo.canonicalize(cr.poly, 20000, 1e-13);

    const inv = Geo.computeInvariants(cr.poly);
    const fvC = fVectorOf(cr.poly);
    const fsv = faceSizeVector(cr.poly);
    const sumCheck = Object.entries(fsv).reduce((s, [k, v]) => s + (6 - Number(k)) * v, 0);

    state.invalid = { type: entry.invalidType, m: cr.nonIsolatedPentagonPairs || cr.isolatedHexagonCount };
    state.highlightEdges = cr.nonIsolatedPentagonEdges;
    state.fullerene = fullerene;
    state.contracted = {
      poly: cr.poly, mapping: cr.mapping, counts: cr.counts, admissible: cr.admissible,
      poleCount: cr.poleCount, keptCount: cr.keptCount, poleIndices: computePoleIndices(cr.poly),
      anomalousPoles: cr.anomalousPoles || [], inv, fvC, fsv, sumCheck
    };
    setMsg(invalidMsg(state.invalid), true);
    afterNewPoly(false);
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

  function afterNewPoly(showContracted) {
    state.contractedOn = showContracted;
    if (showContracted) {
      Renderer.setPoly(state.contracted.poly, state.contracted.poleIndices, false);
    } else {
      Renderer.setPoly(state.fullerene, null, true, state.highlightEdges, computeIsolatedHexFaceIndices());
    }
    updateContractBtn();
    updateReadout();
  }

  // ---------------------------------------------------------------------------
  // Pole-contraction animation
  // ---------------------------------------------------------------------------
  function toggleContraction() {
    if (!state.fullerene || !state.contracted || state.animating) return;
    const turningOn = !state.contractedOn;
    state.animating = true;
    const duration = 600;
    const t0 = performance.now();

    const nFull = state.fullerene.verts.length;
    const fromPositions = state.fullerene.verts.map(v => v.clone());
    const targetPositions = new Array(nFull);
    for (let i = 0; i < nFull; i++) {
      const mapped = state.contracted.mapping[i];
      targetPositions[i] = state.contracted.poly.verts[mapped].clone();
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
        if (turningOn) {
          Renderer.setPoly(state.contracted.poly, state.contracted.poleIndices, false);
        } else {
          Renderer.setPoly(state.fullerene, null, true, state.highlightEdges, computeIsolatedHexFaceIndices());
        }
        updateContractBtn();
        updateReadout();
      }
    }
    requestAnimationFrame(frame);
  }

  function updateContractBtn() {
    const btn = $('contractBtn');
    if (!state.fullerene) {
      btn.textContent = 'Contract poles →';
      btn.disabled = true;
      btn.title = state.invalid && state.invalid.type === 'nonIsolatedPentagons'
        ? "Fullerene reconstruction isn't available for this non-IPR isomer — the two adjacent pentagon poles can't be unambiguously expanded back from the contracted data alone."
        : '';
    } else {
      btn.textContent = state.contractedOn ? '← Expand to fullerene' : 'Contract poles →';
      btn.disabled = false;
      btn.title = '';
    }
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
    if (state.fullerene) {
      const fvF = fVectorOf(state.fullerene);
      lines.push(row('Fullerene f-vector:', `(${fvF.V},${fvF.E},${fvF.F})`));
    }
    const c = state.contracted;
    lines.push(row('C(n) f-vector:', `(${c.fvC.V},${c.fvC.E},${c.fvC.F})`));
    const fsvStr = Object.keys(c.fsv).sort().map(k => `${k}:${c.fsv[k]}`).join(', ');
    lines.push(row('Face-size vector:', `{${fsvStr}}`));
    lines.push(rowHtml('ρ (rho):', fmtHit(c.inv.rho, 6)));
    lines.push(rowHtml('ι (iota):', fmtHit(c.inv.iota, 4)));
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
    $('generateBtn').disabled = !!reason;
  }

  function setN(n) {
    n = Math.max(20, Math.min(60, Math.round(n)));
    state.n = n;
    $('nSlider').value = n;
    $('nInput').value = n;
    updateNAvailability();
  }

  // ---------------------------------------------------------------------------
  // OFF export
  // ---------------------------------------------------------------------------
  function exportOFF() {
    const poly = state.contractedOn ? state.contracted.poly : state.fullerene;
    if (!poly) return;
    let lines = ['OFF', `${poly.verts.length} ${poly.faces.length} 0`];
    for (const v of poly.verts) lines.push(`${v.x.toFixed(10)} ${v.y.toFixed(10)} ${v.z.toFixed(10)}`);
    for (const f of poly.faces) lines.push(`${f.length} ${f.join(' ')}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = $('exportLink');
    a.href = url;
    a.download = `${state.contractedOn ? 'C' + state.n : 'fullerene_C' + (2 * state.n + 20)}.off`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  function renderLegend() {
    const labels = {
      triangle: 'triangle', rhombus: 'rhombus/near-rhombus', trapezoid: 'trapezoid/skew quadrilateral',
      floretPentagon: 'floret pentagon',
      fullereneHexagon: 'hexagon (fullerene)', fullerenePentagon: 'pole pentagon (fullerene)',
      error: 'isolated hexagon (error)'
    };
    const rows = Object.entries(Renderer.FACE_COLORS).map(([key, hex]) => {
      const col = '#' + hex.toString(16).padStart(6, '0');
      return `<div><span style="display:inline-block;width:10px;height:10px;background:${col};border:1px solid var(--border);margin-right:6px;vertical-align:middle;"></span>${labels[key] || key}</div>`;
    });
    const highlightCol = '#' + (0xd633c4).toString(16).padStart(6, '0');
    rows.push(`<div><span style="display:inline-block;width:10px;height:2px;background:${highlightCol};margin-right:6px;margin-bottom:4px;vertical-align:middle;"></span>pentagon-pentagon edge (error)</div>`);
    $('legend').innerHTML = rows.join('');
  }

  function main() {
    Renderer.init($('c'));
    renderLegend();

    $('nSlider').addEventListener('input', e => setN(+e.target.value));
    $('nInput').addEventListener('change', e => setN(+e.target.value));
    $('generateBtn').addEventListener('click', () => generate(state.n));
    $('contractBtn').addEventListener('click', toggleContraction);
    $('exportBtn').addEventListener('click', exportOFF);

    $('tglColor').addEventListener('change', e => { Renderer.setToggles({ color: e.target.checked }); });
    $('tglEdges').addEventListener('change', e => { Renderer.setToggles({ edges: e.target.checked }); });
    $('tglSphere').addEventListener('change', e => { Renderer.setToggles({ sphere: e.target.checked }); });
    $('tglPoles').addEventListener('change', e => { Renderer.setToggles({ poles: e.target.checked }); });
    $('tglIsolatedHex').addEventListener('change', e => { Renderer.setToggles({ highlightIsolatedHex: e.target.checked }); });
    $('tglSpin').addEventListener('change', e => { Renderer.setToggles({ spin: e.target.checked }); });

    setN(20);
    generate(20);

    Renderer.startLoop(() => {
      $('hud').textContent = state.contracted
        ? `${state.contractedOn ? 'C(' + state.n + ')' : 'C' + (2 * state.n + 20) + ' fullerene'} — drag to orbit, scroll to zoom`
        : '';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main); else main();
})();

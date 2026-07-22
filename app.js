// ===================================================================================
// app.js — UI wiring, state, self-tests. No build step; everything lives in memory.
// ===================================================================================
(function () {
  'use strict';

  const NO_IPR = new Set([21, 22, 23, 24]);          // spec: no IPR fullerene exists at all
  const NO_ADMISSIBLE = new Set([26, 53, 54, 56, 57, 58, 59]); // spec: no admissible isomer
  const ICOSAHEDRAL_N = new Set([20, 30, 60]); // the 3 isohedral cases (rho = iota = 1 exactly)

  const state = {
    n: 20,
    fullerene: null,          // canonicalized Poly, pentagon/hexagon faces (reconstructed)
    contracted: null,         // {poly, mapping, counts, admissible, poleCount, keptCount} loaded C(n)
    contractedOn: false,      // are we currently showing C(n)?
    animating: false
  };

  const $ = id => document.getElementById(id);

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

  function pointGroupGuess(n) {
    if (n === 20 || n === 30) return 'I_h';
    if (n === 60) return 'I';
    return 'C_1 (generic isomer)';
  }

  // ---------------------------------------------------------------------------
  // Generation — load C(n) directly from the published, pre-solved coordinate
  // table (catalan_data.js), then reconstruct the underlying fullerene by
  // expanding each pole back into a pentagon (for the "contract poles" toggle).
  // ---------------------------------------------------------------------------
  function reasonForN(n) {
    if (NO_IPR.has(n)) return 'No IPR fullerene exists at all for this n — pole contraction is undefined.';
    if (NO_ADMISSIBLE.has(n)) return 'No admissible isomer is known for this n — every IPR fullerene retains an isolated hexagon.';
    if (!window.CATALAN_TABLE[String(n)]) return 'No published coordinates for this n.';
    return '';
  }

  function generate(n) {
    const entry = window.CATALAN_TABLE[String(n)];
    if (!entry) { setMsg(reasonForN(n) || `No data for n=${n}.`, true); return; }

    const cVerts = entry.verts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const cPoly = { verts: cVerts, faces: entry.faces.map(f => f.slice()) };
    Geo.fixOrientationConsistency(cPoly);
    const inv = Geo.computeInvariants(cPoly);
    const fvC = fVectorOf(cPoly);
    const fsv = faceSizeVector(cPoly);
    const sumCheck = Object.entries(fsv).reduce((s, [k, v]) => s + (6 - Number(k)) * v, 0);

    const exp = Geo.poleExpand(cPoly);
    if (!exp.ok) { setMsg('Pole expansion (C(n) → fullerene) failed: ' + exp.msg, true); return; }
    const fullerene = exp.fullerene;
    Geo.fixOrientationConsistency(fullerene);
    Geo.canonicalize(fullerene, 5000, 1e-13);

    // Build fullerene-vertex -> C(n)-vertex mapping for the contraction morph animation:
    // kept vertices map straight through keepId; pole-wedge vertices all map to their pole.
    const fullMapping = new Array(fullerene.verts.length);
    for (const [oldV, newId] of exp.keepId) fullMapping[newId] = oldV;
    for (const P of exp.poles) for (const newId of exp.poleNewIds.get(P)) fullMapping[newId] = P;

    state.n = n;
    state.fullerene = fullerene;
    state.contracted = { poly: cPoly, mapping: fullMapping, counts: countFaceTypes(cPoly), admissible: true, poleCount: 12, keptCount: fvC.V - 12, inv, fvC, fsv, sumCheck };
    state.contractedOn = false;
    setMsg('', false);
    afterNewPoly();
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

  function afterNewPoly() {
    Renderer.setPoly(state.fullerene, null);
    state.contractedOn = false;
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
          const poleIdx = [];
          const seenPole = new Set();
          for (let i = 0; i < nFull; i++) {
            const mapped = state.contracted.mapping[i];
            if (mapped < state.contracted.poleCount && !seenPole.has(mapped)) { seenPole.add(mapped); poleIdx.push(mapped); }
          }
          Renderer.setPoly(state.contracted.poly, poleIdx);
        } else {
          Renderer.setPoly(state.fullerene, null);
        }
        updateContractBtn();
        updateReadout();
      }
    }
    requestAnimationFrame(frame);
  }

  function updateContractBtn() {
    const btn = $('contractBtn');
    btn.textContent = state.contractedOn ? '← Expand to fullerene' : 'Contract poles →';
    btn.disabled = !state.fullerene;
  }

  // ---------------------------------------------------------------------------
  // Readout
  // ---------------------------------------------------------------------------
  function fmtHit(val, digits, isOne) {
    const s = val.toFixed(digits);
    const hit = isOne && Math.abs(val - 1) < 5e-7;
    return `<span class="v${hit ? ' hit' : ''}">${s}</span>`;
  }

  function updateReadout() {
    const el = $('readout');
    if (!state.fullerene) { el.innerHTML = ''; return; }
    const n = state.n;
    const fvF = fVectorOf(state.fullerene);
    let lines = [];
    lines.push(row('n', n));
    lines.push(row('Source', `published coordinates (C${2 * n + 20})`));
    lines.push(row('Point group', pointGroupGuess(n)));
    lines.push(row('Fullerene f-vector', `(${fvF.V},${fvF.E},${fvF.F})`));
    const c = state.contracted;
    lines.push(row('C(n) f-vector', `(${c.fvC.V},${c.fvC.E},${c.fvC.F})`));
    const fsvStr = Object.keys(c.fsv).sort().map(k => `${k}:${c.fsv[k]}`).join(', ');
    lines.push(row('Face-size vector', `{${fsvStr}}`));
    lines.push(rowHtml('ρ (rho)', fmtHit(c.inv.rho, 6, ICOSAHEDRAL_N.has(n))));
    lines.push(rowHtml('ι (iota)', fmtHit(c.inv.iota, 4, ICOSAHEDRAL_N.has(n))));
    lines.push(row('Poles / kept vertices', `${c.poleCount} / ${c.keptCount}`));
    lines.push(row('Σ p(h) check', `${c.sumCheck} (expect 60)${c.sumCheck === 60 ? ' ✓' : ' ✗'}`));
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
  // Self-tests
  // ---------------------------------------------------------------------------
  function runSelfTests() {
    const out = [];
    let allPass = true;
    function check(name, cond, detail) {
      allPass = allPass && cond;
      out.push(`<span class="${cond ? 'pass' : 'fail'}">${cond ? 'PASS' : 'FAIL'}</span>  ${name}${detail ? '  ' + detail : ''}`);
    }

    const table = window.CATALAN_TABLE;
    const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
    check(`published table has entries`, keys.length > 0, `${keys.length} entries`);
    for (const n of [20, 30, 60]) {
      const entry = table[String(n)];
      if (!entry) { check(`n=${n} present in table`, false); continue; }
      const verts = entry.verts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      const poly = { verts, faces: entry.faces.map(f => f.slice()) };
      const inv = Geo.computeInvariants(poly);
      check(`n=${n} ρ ≈ 1.000000`, Math.abs(inv.rho - 1) < 1e-6, `ρ=${inv.rho.toFixed(8)}`);
      check(`n=${n} ι ≈ 1.0000`, Math.abs(inv.iota - 1) < 1e-4, `ι=${inv.iota.toFixed(8)}`);
      const exp = Geo.poleExpand(poly);
      check(`n=${n} pole expansion succeeds`, exp.ok, exp.ok ? '' : exp.msg);
    }
    let expandFails = 0;
    for (const n of keys) {
      const entry = table[String(n)];
      const verts = entry.verts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      const poly = { verts, faces: entry.faces.map(f => f.slice()) };
      if (!Geo.poleExpand(poly).ok) expandFails++;
    }
    check(`all ${keys.length} table entries expand to a valid fullerene`, expandFails === 0, expandFails ? `${expandFails} failed` : '');

    $('selftest').innerHTML = out.join('\n') + `\n\n${allPass ? '<span class="pass">All gates passed.</span>' : '<span class="fail">Some gates FAILED.</span>'}`;
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------
  function renderLegend() {
    const labels = {
      triangle: 'Triangle', rhombus: 'Rhombus', trapezoid: 'Trapezoid',
      shieldPentagon: 'Shield pentagon (C(n))',
      fullereneHexagon: 'Hexagon (fullerene)', fullerenePentagon: 'Regular pentagon (fullerene)'
    };
    const rows = Object.entries(Renderer.FACE_COLORS).map(([key, hex]) => {
      const col = '#' + hex.toString(16).padStart(6, '0');
      return `<div><span style="display:inline-block;width:10px;height:10px;background:${col};border:1px solid var(--border);margin-right:6px;vertical-align:middle;"></span>${labels[key] || key}</div>`;
    });
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
    $('tglSpin').addEventListener('change', e => { Renderer.setToggles({ spin: e.target.checked }); });

    setN(20);
    runSelfTests();
    generate(20);

    Renderer.startLoop(() => {
      $('hud').textContent = state.fullerene
        ? `${state.contractedOn ? 'C(' + state.n + ')' : 'C' + (2 * state.n + 20) + ' fullerene'} — drag to orbit, scroll to zoom`
        : '';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main); else main();
})();

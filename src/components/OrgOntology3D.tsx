/**
 * Organisation ontology in 3D: the domain at the centre, capability families
 * on a fixed ring, skills inside their family, established roles below, and
 * emerging roles above — glowing, with particles flowing in from the roles
 * they were born from. Every position is computed up front (no physics), the
 * camera glides, and a time index grows emerging roles in month by month.
 *
 * three touches `window`, so this module is loaded lazily on the client only.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

import {
  roleSkillNodes,
  type EmergingRole,
  type OrgOntology,
  type OrgRole,
} from "@/lib/org-ontology";

export type OntologyFocus =
  | { kind: "emerging"; id: string }
  | { kind: "role"; id: string }
  | { kind: "skill"; name: string }
  | null;

const statusAt = (e: EmergingRole, t: number) =>
  t < e.signal
    ? null
    : e.established !== null && t >= e.established
      ? "established"
      : e.emerging !== null && t >= e.emerging
        ? "emerging"
        : "signal";

function glowTexture(color: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, color);
  g.addColorStop(0.25, `${color}aa`);
  g.addColorStop(1, `${color}00`);
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeLabel(text: string, style: string) {
  const d = document.createElement("div");
  d.textContent = text;
  d.style.cssText = `color:#d7d9ec;font:500 11px Inter,system-ui,sans-serif;white-space:nowrap;text-shadow:0 1px 3px #000,0 0 8px #000;transition:opacity .3s;${style}`;
  return new CSS2DObject(d);
}

/**
 * Angles as close to their preferred values as possible while every pair is at
 * least `gap` apart (around the circle). Deterministic: a few relaxation passes.
 */
function spreadAngles(prefs: number[], gap: number): number[] {
  const TAU = Math.PI * 2;
  const a = prefs.map((x) => ((x % TAU) + TAU) % TAU);
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    const order = a.map((x, i) => [x, i] as const).sort((x, y) => x[0] - y[0]);
    for (let k = 0; k < order.length; k++) {
      const [, i] = order[k]!;
      const [, j] = order[(k + 1) % order.length]!;
      if (i === j) continue;
      let d = a[j]! - a[i]!;
      if (d < 0) d += TAU;
      if (d < gap) {
        const push = (gap - d) / 2;
        a[i] = (a[i]! - push + TAU) % TAU;
        a[j] = (a[j]! + push) % TAU;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return a;
}

type Pickable = THREE.Mesh & {
  userData: { kind: "skill" | "role" | "emerging"; id: string; lbl?: CSS2DObject };
};

export type OntologyRecorder = { record: (ms: number) => Promise<Blob> };

export function OrgOntology3D({
  ont,
  time,
  focus,
  onSelect,
  height = 620,
  recorderRef,
}: {
  ont: OrgOntology;
  time: number;
  focus: OntologyFocus;
  onSelect: (f: OntologyFocus) => void;
  height?: number | string;
  /** Exposes record(ms): the map with its labels as a WebM video. */
  recorderRef?: React.MutableRefObject<OntologyRecorder | null> | undefined;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef(time);
  const focusRef = useRef(focus);
  const selectRef = useRef(onSelect);
  const flyRef = useRef<((f: OntologyFocus) => void) | null>(null);
  timeRef.current = time;
  selectRef.current = onSelect;

  useEffect(() => {
    focusRef.current = focus;
    flyRef.current?.(focus);
  }, [focus]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const W = () => el.clientWidth;
    const H = () => el.clientHeight;

    // preserveDrawingBuffer: the recorder copies each finished frame
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W(), H());
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.setSize(W(), H());
    labels.domElement.style.cssText = "position:absolute;inset:0;pointer-events:none";
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0a0b16, 0.0042);
    const camera = new THREE.PerspectiveCamera(48, W() / H(), 1, 2000);
    const home = () => (W() < 600 ? 300 : 235);
    camera.position.set(0, 110, home());
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.minDistance = 60;
    controls.maxDistance = 460;
    controls.target.set(0, 24, 0);
    // plain scrolling moves the page; Ctrl/⌘ + scroll (or a pinch) zooms the map
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) ev.stopPropagation();
    };
    el.addEventListener("wheel", onWheel, { capture: true });

    scene.add(new THREE.HemisphereLight(0xbfc8ff, 0x10111a, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(80, 140, 120);
    scene.add(key);
    const rim = new THREE.PointLight(0x8b7dff, 900, 600);
    rim.position.set(-120, -40, -100);
    scene.add(rim);
    {
      const g = new THREE.BufferGeometry();
      const p: number[] = [];
      for (let i = 0; i < 1200; i++) {
        const r = 500 + Math.random() * 500,
          a = Math.random() * Math.PI * 2,
          b = Math.acos(2 * Math.random() - 1);
        p.push(r * Math.sin(b) * Math.cos(a), r * Math.cos(b), r * Math.sin(b) * Math.sin(a));
      }
      g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
      scene.add(
        new THREE.Points(
          g,
          new THREE.PointsMaterial({
            color: 0x6b6f99,
            size: 1.4,
            transparent: true,
            opacity: 0.55,
          }),
        ),
      );
    }
    const GLOW = glowTexture("#ffb648");
    const pickables: Pickable[] = [];

    /* ---- domain core */
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(7, 3),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x8b7dff,
        emissiveIntensity: 0.6,
        roughness: 0.3,
        metalness: 0.2,
      }),
    );
    scene.add(core);
    const cl = makeLabel(ont.domain.name, "font-weight:800;font-size:14px;color:#fff");
    cl.position.set(0, 12, 0);
    core.add(cl);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture("#8b7dff"),
        depthWrite: false,
        transparent: true,
        opacity: 0.6,
      }),
    );
    halo.scale.set(48, 48, 1);
    scene.add(halo);

    /* ---- families and skills */
    const skillPos = new Map<string, { p: THREE.Vector3; col: THREE.Color }>();
    const lower = (s: string) => s.toLowerCase();
    ont.families.forEach((f, i) => {
      const a = (i / ont.families.length) * Math.PI * 2;
      const center = new THREE.Vector3(Math.cos(a) * 92, Math.sin(a * 2) * 14, Math.sin(a) * 92);
      const col = new THREE.Color(f.color);
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(19, 40, 40),
        new THREE.MeshStandardMaterial({
          color: col,
          transparent: true,
          opacity: 0.07,
          roughness: 1,
          depthWrite: false,
        }),
      );
      shell.position.copy(center);
      scene.add(shell);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(19, 0.18, 8, 90),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35 }),
      );
      ring.position.copy(center);
      ring.rotation.x = Math.PI / 2;
      scene.add(ring);
      const fl = makeLabel(
        f.name,
        "font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#fff",
      );
      fl.position.copy(center).add(new THREE.Vector3(0, 25, 0));
      scene.add(fl);
      scene.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), center]),
          new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.18 }),
        ),
      );
      f.skills.forEach((s, j) => {
        const n = f.skills.length,
          y = 1 - (j / Math.max(n - 1, 1)) * 2,
          r = Math.sqrt(Math.max(0, 1 - y * y)),
          th = j * 2.399963;
        const p = center
          .clone()
          .add(new THREE.Vector3(Math.cos(th) * r * 11, y * 9, Math.sin(th) * r * 11));
        skillPos.set(lower(s.name), { p, col });
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(
            1.4 + Math.min(1.6, Math.sqrt(s.demand + s.supply) * 0.45),
            20,
            20,
          ),
          new THREE.MeshStandardMaterial({
            color: col,
            emissive: col,
            emissiveIntensity: 0.35,
            roughness: 0.45,
            transparent: true,
          }),
        ) as unknown as Pickable;
        m.position.copy(p);
        m.userData = { kind: "skill", id: s.name };
        const sl = makeLabel(s.name, "");
        sl.position.set(0, 3.4, 0);
        m.add(sl);
        m.userData.lbl = sl;
        scene.add(m);
        pickables.push(m);
      });
    });

    /* ---- established roles */
    const rolePos = new Map<string, THREE.Vector3>();
    const roleMesh = new Map<string, THREE.Object3D>();
    const roleLinks: { line: THREE.Line; role: string; skill: string }[] = [];
    // each role sits on an inner ring, at the angle of its skills, kept apart
    const roleAngle = new Map<string, number>();
    {
      const prefs = ont.roles.map((r, i) => {
        const pts = roleSkillNodes(r, ont.families)
          .map((n) => skillPos.get(lower(n))?.p)
          .filter((x): x is THREE.Vector3 => !!x);
        if (!pts.length) return (i / Math.max(ont.roles.length, 1)) * Math.PI * 2;
        const sx = pts.reduce((a, q) => a + Math.cos(Math.atan2(q.z, q.x)), 0);
        const sz = pts.reduce((a, q) => a + Math.sin(Math.atan2(q.z, q.x)), 0);
        return Math.atan2(sz, sx);
      });
      const spread = spreadAngles(
        prefs,
        Math.min(0.75, ((Math.PI * 2) / Math.max(ont.roles.length, 1)) * 0.85),
      );
      ont.roles.forEach((r, i) => roleAngle.set(r.id, spread[i]!));
    }
    const placeRole = (r: OrgRole) => {
      const names = roleSkillNodes(r, ont.families);
      const a = roleAngle.get(r.id) ?? 0;
      const p = new THREE.Vector3(Math.cos(a) * 58, -34, Math.sin(a) * 58);
      rolePos.set(r.id, p);
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(3.6 + Math.min(2.4, Math.sqrt(r.demand) * 0.6)),
        new THREE.MeshStandardMaterial({
          color: 0xdfe3ff,
          emissive: 0x5560a0,
          emissiveIntensity: 0.5,
          roughness: 0.25,
          metalness: 0.35,
          flatShading: true,
          transparent: true,
        }),
      ) as unknown as Pickable;
      m.position.copy(p);
      m.userData = { kind: "role", id: r.id };
      const rl = makeLabel(r.name, "font-weight:600;font-size:12px;color:#fff");
      rl.position.set(0, -7.5, 0);
      m.add(rl);
      scene.add(m);
      pickables.push(m);
      roleMesh.set(r.id, m);
      for (const n of names) {
        const sp = skillPos.get(lower(n));
        if (!sp) continue;
        const curve = new THREE.QuadraticBezierCurve3(
          p,
          p
            .clone()
            .lerp(sp.p, 0.5)
            .add(new THREE.Vector3(0, 10, 0)),
          sp.p,
        );
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(28)),
          new THREE.LineBasicMaterial({ color: sp.col, transparent: true, opacity: 0.22 }),
        );
        scene.add(line);
        roleLinks.push({ line, role: r.id, skill: n });
      }
    };
    ont.roles.forEach(placeRole);

    /* ---- emerging roles: above, spread by direction and height */
    type Em = {
      e: EmergingRole;
      mesh: Pickable;
      glow: THREE.Sprite;
      label: CSS2DObject;
      streams: {
        curve: THREE.Curve<THREE.Vector3>;
        line: THREE.Line;
        dots: { s: THREE.Sprite; off: number }[];
      }[];
      skillLines: THREE.Line[];
      pos: THREE.Vector3;
      scale: number;
    };
    const ems: Em[] = [];
    // new roles on an upper ring, near the angle of their parents, kept apart
    const emAngles = spreadAngles(
      ont.emerging.map((e, k) => {
        const ps = e.parents.map((id) => rolePos.get(id)).filter((x): x is THREE.Vector3 => !!x);
        if (!ps.length) return (k / Math.max(ont.emerging.length, 1)) * Math.PI * 2;
        return Math.atan2(
          ps.reduce((a, q) => a + Math.sin(Math.atan2(q.z, q.x)), 0),
          ps.reduce((a, q) => a + Math.cos(Math.atan2(q.z, q.x)), 0),
        );
      }),
      Math.min(0.9, ((Math.PI * 2) / Math.max(ont.emerging.length, 1)) * 0.85),
    );
    ont.emerging.forEach((e, k) => {
      const parents = e.parents.map((id) => rolePos.get(id)).filter((x): x is THREE.Vector3 => !!x);
      const mid = parents.length
        ? parents
            .reduce((a, b) => a.clone().add(b), new THREE.Vector3())
            .divideScalar(parents.length)
        : new THREE.Vector3(1, 0, 0);
      void mid;
      const ang = emAngles[k]!;
      const pos = new THREE.Vector3(Math.cos(ang) * 70, 50 + (k % 3) * 14, Math.sin(ang) * 70);
      rolePos.set(e.id, pos);
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(4.6, 1),
        new THREE.MeshStandardMaterial({
          color: 0xffc56b,
          emissive: 0xff9a1f,
          emissiveIntensity: 1.1,
          roughness: 0.25,
          metalness: 0.1,
          transparent: true,
        }),
      ) as unknown as Pickable;
      mesh.position.copy(pos);
      mesh.userData = { kind: "emerging", id: e.id };
      scene.add(mesh);
      pickables.push(mesh);
      roleMesh.set(e.id, mesh);
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: GLOW,
          depthWrite: false,
          transparent: true,
          blending: THREE.AdditiveBlending,
        }),
      );
      glow.scale.set(30, 30, 1);
      mesh.add(glow);
      const label = makeLabel(e.name, "font-weight:700;font-size:12.5px;color:#ffb648");
      label.position.set(0, 8.5, 0);
      mesh.add(label);
      const streams = parents.map((pp) => {
        const curve = new THREE.CatmullRomCurve3([
          pp,
          pp
            .clone()
            .lerp(pos, 0.5)
            .add(new THREE.Vector3(0, 22, 0)),
          pos,
        ]);
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)),
          new THREE.LineBasicMaterial({ color: 0xffb648, transparent: true, opacity: 0.55 }),
        );
        scene.add(line);
        const dots = Array.from({ length: 6 }, (_, i) => {
          const s = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: GLOW,
              depthWrite: false,
              transparent: true,
              blending: THREE.AdditiveBlending,
            }),
          );
          s.scale.set(3.2, 3.2, 1);
          scene.add(s);
          return { s, off: i / 6 };
        });
        return { curve, line, dots };
      });
      const skillLines = e.skills
        .map((s) => {
          const sp = skillPos.get(lower(s));
          if (!sp) return null;
          const l = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([pos, sp.p]),
            new THREE.LineDashedMaterial({
              color: 0xffb648,
              dashSize: 1.6,
              gapSize: 1.6,
              transparent: true,
              opacity: 0.28,
            }),
          );
          l.computeLineDistances();
          scene.add(l);
          return l;
        })
        .filter((x) => x !== null) as THREE.Line[];
      ems.push({ e, mesh, glow, label, streams, skillLines, pos, scale: 0 });
    });

    /* ---- focus, picking and camera */
    const related = (m: Pickable): boolean => {
      const f = focusRef.current;
      if (!f) return true;
      const u = m.userData;
      if (f.kind === "emerging") {
        const e = ont.emerging.find((x) => x.id === f.id);
        if (!e) return true;
        return (
          (u.kind === "emerging" && u.id === e.id) ||
          (u.kind === "role" && e.parents.includes(u.id)) ||
          (u.kind === "skill" && e.skills.some((s) => lower(s) === lower(u.id)))
        );
      }
      if (f.kind === "role") {
        const r = ont.roles.find((x) => x.id === f.id);
        const names = r ? roleSkillNodes(r, ont.families).map(lower) : [];
        return (
          (u.kind === "role" && u.id === f.id) ||
          (u.kind === "skill" && names.includes(lower(u.id))) ||
          (u.kind === "emerging" &&
            !!ont.emerging.find((x) => x.id === u.id)?.parents.includes(f.id))
        );
      }
      const name = lower(f.name);
      if (u.kind === "skill") return lower(u.id) === name;
      if (u.kind === "role") {
        const r = ont.roles.find((x) => x.id === u.id);
        return !!r && roleSkillNodes(r, ont.families).some((s) => lower(s) === name);
      }
      return !!ont.emerging.find((x) => x.id === u.id)?.skills.some((s) => lower(s) === name);
    };
    let fly: { target: THREE.Vector3; dist: number } | null = null;
    flyRef.current = (f) => {
      if (!f) {
        fly = { target: new THREE.Vector3(0, 24, 0), dist: home() };
        controls.autoRotate = true;
        return;
      }
      controls.autoRotate = false;
      if (f.kind === "skill") {
        const sp = skillPos.get(lower(f.name));
        if (sp) fly = { target: sp.p.clone(), dist: 90 };
        return;
      }
      const m = roleMesh.get(f.id);
      if (!m) return;
      const p = m.position.clone();
      let dist = 150;
      if (f.kind === "emerging") {
        const e = ont.emerging.find((x) => x.id === f.id);
        const pts = [
          p,
          ...(e?.parents ?? []).map((id) => rolePos.get(id)).filter((x): x is THREE.Vector3 => !!x),
        ];
        const c = pts
          .reduce((a, b) => a.clone().add(b), new THREE.Vector3())
          .divideScalar(pts.length);
        dist = Math.max(170, Math.max(...pts.map((q) => q.distanceTo(c))) * 2.6);
        p.copy(c);
      }
      if (W() < 760) dist *= 1.25;
      fly = { target: p, dist };
    };
    if (focusRef.current) flyRef.current(focusRef.current);

    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let hovered: Pickable | null = null;
    const pick = (ev: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.set(
        ((ev.clientX - r.left) / r.width) * 2 - 1,
        -((ev.clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(mouse, camera);
      return (
        (ray.intersectObjects(pickables, false).find((h) => h.object.visible)?.object as
          Pickable | undefined) ?? null
      );
    };
    const onMove = (ev: PointerEvent) => {
      hovered = pick(ev);
      renderer.domElement.style.cursor = hovered ? "pointer" : "grab";
    };
    let downAt: [number, number] | null = null;
    const onDown = (ev: PointerEvent) => (downAt = [ev.clientX, ev.clientY]);
    const onUp = (ev: PointerEvent) => {
      if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
      const o = pick(ev);
      if (!o) return;
      const u = o.userData;
      selectRef.current(
        u.kind === "skill" ? { kind: "skill", name: u.id } : { kind: u.kind, id: u.id },
      );
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    /* ---- loop */
    const clock = new THREE.Clock();
    const tmp = new THREE.Vector3();
    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05),
        t = clock.elapsedTime;
      const f = focusRef.current;
      if (fly) {
        controls.target.lerp(fly.target, 1 - Math.pow(0.002, dt));
        const dir = tmp.copy(camera.position).sub(controls.target).normalize();
        const want = controls.target.clone().add(dir.multiplyScalar(fly.dist));
        camera.position.lerp(want, 1 - Math.pow(0.01, dt));
        if (camera.position.distanceTo(want) < 0.5 && controls.target.distanceTo(fly.target) < 0.3)
          fly = null;
      }
      for (const m of pickables) {
        if (m.userData.kind === "emerging") continue;
        const on = related(m);
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.opacity += ((on ? 1 : 0.15) - mat.opacity) * Math.min(1, dt * 6);
        if (m.userData.lbl)
          m.userData.lbl.element.style.opacity = f ? (on ? "1" : "0") : hovered === m ? "1" : "0";
        const s = hovered === m ? 1.35 : 1;
        m.scale.lerp(tmp.set(s, s, s), Math.min(1, dt * 8));
      }
      for (const l of roleLinks) {
        const on =
          !f ||
          (f.kind === "role" && f.id === l.role) ||
          (f.kind === "skill" && lower(f.name) === lower(l.skill));
        const mat = l.line.material as THREE.LineBasicMaterial;
        mat.opacity += ((on ? (f ? 0.7 : 0.22) : 0.03) - mat.opacity) * Math.min(1, dt * 6);
      }
      for (const em of ems) {
        const st = statusAt(em.e, timeRef.current);
        const want = !st ? 0 : st === "signal" ? 0.55 : st === "emerging" ? 0.85 : 1;
        em.scale += (want - em.scale) * Math.min(1, dt * 3);
        const on = !f || related(em.mesh);
        const vis = em.scale > 0.02;
        const pulse = 1 + Math.sin(t * 2.4 + em.pos.x) * 0.06;
        em.mesh.visible = vis;
        em.mesh.scale.setScalar(
          Math.max(0.001, em.scale * pulse * (hovered === em.mesh ? 1.2 : 1)),
        );
        (em.mesh.material as THREE.MeshStandardMaterial).opacity = on ? 1 : 0.2;
        em.glow.material.opacity = (on ? 0.85 : 0.15) * em.scale;
        em.label.element.style.opacity = vis ? (on ? "1" : "0.15") : "0";
        for (const s of em.streams) {
          (s.line.material as THREE.LineBasicMaterial).opacity = vis
            ? (on ? 0.55 : 0.06) * em.scale
            : 0;
          for (const d of s.dots) {
            const u = (t * 0.18 + d.off) % 1;
            s.curve.getPoint(u, d.s.position);
            d.s.material.opacity = vis ? (on ? 0.9 : 0.1) * Math.sin(u * Math.PI) * em.scale : 0;
          }
        }
        const mine = f?.kind === "emerging" && f.id === em.e.id;
        for (const l of em.skillLines)
          (l.material as THREE.LineDashedMaterial).opacity = vis
            ? mine
              ? 0.55
              : 0.12 * em.scale
            : 0;
      }
      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
      if (rec) composite(rec.ctx);
    };

    /* ---- recording: the WebGL frame plus the HTML labels, drawn on one canvas */
    let rec: { ctx: CanvasRenderingContext2D } | null = null;
    const labelObjects: CSS2DObject[] = [];
    scene.traverse((o) => {
      if (o instanceof CSS2DObject) labelObjects.push(o);
    });
    const proj = new THREE.Vector3();
    const composite = (ctx: CanvasRenderingContext2D) => {
      const w = ctx.canvas.width,
        h = ctx.canvas.height;
      ctx.fillStyle = "#0b0c18";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(renderer.domElement, 0, 0, w, h);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const o of labelObjects) {
        const e = o.element;
        const op = Number(e.style.opacity || "1");
        if (!o.visible || op < 0.05 || e.style.display === "none") continue;
        let hidden = false;
        o.traverseAncestors((a) => {
          if (!a.visible) hidden = true;
        });
        if (hidden) continue;
        o.getWorldPosition(proj).project(camera);
        if (proj.z > 1) continue;
        const cs = getComputedStyle(e);
        ctx.globalAlpha = op;
        ctx.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * (w / W())}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = cs.color;
        ctx.shadowColor = "#000";
        ctx.shadowBlur = 6;
        ctx.fillText(
          cs.textTransform === "uppercase"
            ? (e.textContent ?? "").toUpperCase()
            : (e.textContent ?? ""),
          ((proj.x + 1) / 2) * w,
          ((1 - proj.y) / 2) * h,
        );
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };
    if (recorderRef)
      recorderRef.current = {
        record: (ms) =>
          new Promise<Blob>((resolve, reject) => {
            const canvas = document.createElement("canvas");
            canvas.width = renderer.domElement.width;
            canvas.height = renderer.domElement.height;
            const ctx = canvas.getContext("2d");
            if (!ctx || typeof MediaRecorder === "undefined") {
              reject(new Error("This browser cannot record video."));
              return;
            }
            const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
              (m) => MediaRecorder.isTypeSupported(m),
            );
            const recorder = new MediaRecorder(canvas.captureStream(30), {
              ...(mime ? { mimeType: mime } : {}),
              videoBitsPerSecond: 6_000_000,
            });
            const chunks: Blob[] = [];
            recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
            recorder.onstop = () => {
              rec = null;
              resolve(new Blob(chunks, { type: mime ?? "video/webm" }));
            };
            rec = { ctx };
            composite(ctx);
            recorder.start(500);
            setTimeout(() => recorder.state !== "inactive" && recorder.stop(), ms);
          }),
      };
    animate();

    const ro = new ResizeObserver(() => {
      camera.aspect = W() / Math.max(H(), 1);
      camera.updateProjectionMatrix();
      renderer.setSize(W(), H());
      labels.setSize(W(), H());
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      if (recorderRef) recorderRef.current = null;
      ro.disconnect();
      el.removeEventListener("wheel", onWheel, { capture: true });
      flyRef.current = null;
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      el.replaceChildren();
    };
  }, [ont]);

  return (
    <div
      ref={host}
      className="relative w-full overflow-hidden rounded-xl"
      style={{
        height,
        background:
          "radial-gradient(1000px 700px at 55% 45%, #161a33 0%, #0b0c18 55%, #06070d 100%)",
      }}
      role="img"
      aria-label={`${ont.domain.name} organisation ontology: ${ont.families.length} capability families, ${ont.roles.length} roles, ${ont.emerging.length} emerging roles`}
    />
  );
}

import * as THREE from "three";
import pc from "polygon-clipping";
// import { fallbackMapIFC } from "@/components/custom/SceneCanvas/utils/objectFactory";
import { disposeObjectDeep } from "../utils/threeHelpers";
import { cloneAsPhongMaterial, createPhongMaterial } from "../utils/materials";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// --------------------------------------------------------
// Basic types (2D di plane XZ / polygon-clipping style)
// --------------------------------------------------------
type Ring2D = [number, number][];
type Poly2 = Ring2D[];
type MultiPoly = Poly2[];
type Ring2 = Ring2D;
type MultiPoly2 = MultiPoly;
type MultiPolygon = MultiPoly2;

// --------------------------------------------------------
// Numeric & ring helpers
// --------------------------------------------------------
const SNAP_EPS = 1e-5;
const SURFACE_OFFSET = 0.001;
const OUTLINE_OFFSET = 0.0005;

// --- util kecil buat “snap” angka supaya grid-nya rapi & ngilangin 0.4999999 ---
const snap = (v: number, eps = SNAP_EPS): number => {
  if (!Number.isFinite(v)) return v;
  if (Math.abs(v) < eps) return 0;
  return Number(v.toFixed(5));
};

// Backwards-compat helper (dipakai banyak di atas)
const snapCoord = (v: number) => snap(v, SNAP_EPS);

// const _tmpWorldV3 = new THREE.Vector3();

// function ringLocalXZToWorld(mesh: THREE.Object3D, ring: Ring2D): Ring2D {
//   mesh.updateWorldMatrix(true, false);
//   return ring.map(([x, z]) => {
//     _tmpWorldV3.set(x, 0, z).applyMatrix4(mesh.matrixWorld);
//     return [_tmpWorldV3.x, _tmpWorldV3.z] as [number, number];
//   });
// }

export const ensureClosedRing = (ring: Ring2D | null | undefined): Ring2D => {
  if (!ring || !ring.length) return [];
  const normalized = ring.map(
    ([x, z]) => [snapCoord(x), snapCoord(z)] as [number, number]
  );
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (
    Math.abs(first[0] - last[0]) > SNAP_EPS ||
    Math.abs(first[1] - last[1]) > SNAP_EPS
  ) {
    normalized.push([first[0], first[1]]);
  }
  return normalized;
};

// Parse various vertex formats into a Ring2D ([x,z] tuples).
const parseRing2D = (vertices: unknown): Ring2D => {
  if (!Array.isArray(vertices)) return [];
  const ring: Ring2D = [];
  for (const v of vertices as any[]) {
    if (Array.isArray(v)) {
      const x = Number(v[0]);
      const z = Number(v.length >= 3 ? v[2] : v[1]);
      if (Number.isFinite(x) && Number.isFinite(z)) ring.push([x, z]);
      continue;
    }

    const x = Number((v as any)?.x ?? (v as any)?.[0]);
    const z = Number((v as any)?.z ?? (v as any)?.y ?? (v as any)?.[2] ?? (v as any)?.[1]);
    if (Number.isFinite(x) && Number.isFinite(z)) ring.push([x, z]);
  }
  return ring;
};

const parseHoles2D = (holes: unknown): Ring2D[] => {
  if (!Array.isArray(holes)) return [];
  const result: Ring2D[] = [];
  for (const h of holes as any[]) {
    const ring = parseRing2D(h);
    if (ring.length >= 3) result.push(ring);
  }
  return result;
};

const cleanRingForGeometry = (ring: Ring2D): Ring2D => {
  const closed = ensureClosedRing(ring);
  if (closed.length < 2) return closed;
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (
    Math.abs(first[0] - last[0]) < SNAP_EPS &&
    Math.abs(first[1] - last[1]) < SNAP_EPS
  ) {
    return closed.slice(0, closed.length - 1);
  }
  return closed;
};

const normalizeMultiPoly = (mp?: MultiPoly | null): MultiPoly => {
  if (!mp) return [];
  return mp
    .map((poly) => (poly || []).map((ring) => ensureClosedRing(ring)))
    .filter((poly) => poly.some((ring) => ring.length >= 3));
};

/** Utility kecil: cek MultiPoly kosong */
function isEmptyMultiPoly(mp: MultiPoly | null | undefined) {
  if (!mp || !mp.length) return true;
  return !mp.some(
    (poly) => poly && poly.length && poly[0] && poly[0].length >= 3
  );
}

// --------------------------------------------------------
// Geometry helpers: baca ring / poly dari mesh
// --------------------------------------------------------

// Ambil outer ring di plane XZ dari geometry mesh (dalam world space)
function ringFromGeometryXZ(mesh: THREE.Mesh): Ring2D | null {
  const geom = mesh.geometry as THREE.BufferGeometry;
  const posAttr = geom.getAttribute("position") as THREE.BufferAttribute;
  if (!posAttr) return null;

  const v = new THREE.Vector3();
  const pts: { x: number; z: number }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
    const x = v.x;
    const z = v.z;

    // dedupe dengan sedikit toleransi
    const key = `${x.toFixed(5)},${z.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    pts.push({ x, z });
  }

  if (pts.length < 3) return null;

  // susun berurutan mengelilingi centroid
  let cx = 0,
    cz = 0;
  for (const p of pts) {
    cx += p.x;
    cz += p.z;
  }
  cx /= pts.length;
  cz /= pts.length;

  pts.sort((p1, p2) => {
    const a1 = Math.atan2(p1.z - cz, p1.x - cx);
    const a2 = Math.atan2(p2.z - cz, p2.x - cx);
    return a1 - a2;
  });

  const ring: Ring2D = pts.map((p) => [p.x, p.z]);
  return ensureClosedRing(ring);
}

/** Baca polygon 2D (XZ) dari userData.surfaceMeta sebuah floor mesh */
function meshSurfaceToPoly2D(mesh: THREE.Mesh): MultiPoly | null {
  const ud: any = mesh.userData || {};
  const meta = ud.surfaceMeta || {};

  // 0) Kalau sudah punya polyVertices di userData, pakai itu dulu (ini paling aman)
  if (Array.isArray(ud.polyVertices) && ud.polyVertices.length >= 3) {
    const outer = ensureClosedRing(parseRing2D(ud.polyVertices));
    if (outer.length < 4) return null;

    const holes = parseHoles2D(meta.holes ?? ud.polyHoles)
      .map(ensureClosedRing)
      .filter((ring) => ring.length >= 4);

    return [[outer, ...holes]];
  }

  // 1) Pakai surfaceMeta dulu SEBELUM baca dari geometry
  // RECT: center + width + length (diasumsikan di ground XZ, axis-aligned)
  if (meta.kind === "rect" && Array.isArray(meta.center)) {
    const [cx, cz] = meta.center;
    const w = Number(meta.width || 0);
    const l = Number(meta.length || 0);
    if (!isFinite(w) || !isFinite(l) || w <= 0 || l <= 0) return null;

    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const z0 = cz - l / 2;
    const z1 = cz + l / 2;

    const ring: Ring2D = [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ];
    return [[ensureClosedRing(ring)]];
  }

  // POLY dari meta.vertices
  if (meta.kind === "poly" && Array.isArray(meta.vertices)) {
    const outerRing = parseRing2D(meta.vertices);
    if (outerRing.length < 3) return null;

    const holes = parseHoles2D(meta.holes ?? ud.polyHoles)
      .map(ensureClosedRing)
      .filter((ring) => ring.length >= 4);

    return [[ensureClosedRing(outerRing), ...holes]];
  }

  // CIRCLE: approx jadi n-gon
  if (meta.kind === "circle" && Array.isArray(meta.center)) {
    const [cx, cz] = meta.center;
    const r = Number(meta.radius || 0);
    const segments = Math.max(16, Number(meta.segments || 32));
    if (!isFinite(r) || r <= 0) return null;
    const ring: Ring2D = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      ring.push([cx + Math.cos(t) * r, cz + Math.sin(t) * r]);
    }
    return [[ensureClosedRing(ring)]];
  }

  // 2) Fallback terakhir: baca dari geometry (bisa sedikit "kasar" tapi better than nothing)
  const ringFromGeom = ringFromGeometryXZ(mesh);
  if (ringFromGeom && ringFromGeom.length >= 3) {
    return [[ensureClosedRing(ringFromGeom)]];
  }

  return null;
}

// Helper: ambil data poligon dari userData.surfaceMeta ATAU bounding box (world-space)
function meshToPolygon2D(mesh: THREE.Mesh): Poly2 | null {
  // Prefer the same decoding path used by splitFloorsWithNewRect(), but as Poly2.
  const mp = meshSurfaceToPoly2D(mesh);
  if (mp && mp.length && mp[0] && mp[0][0] && mp[0][0].length >= 3) {
    return mp[0];
  }

  const ud: any = mesh.userData || {};
  const meta = ud.surfaceMeta || {};
  const kind = meta.kind || ud.mode;

  // Semuanya asumsi horizontal (lantai), pakai (x, z) di WORLD space
  // ------------------ RECT ------------------
  if (kind === "rect") {
    // Kalau ada center/width/length kita pakai itu di WORLD
    const cxMeta = meta.center?.[0] ?? ud.center?.[0];
    const czMeta = meta.center?.[1] ?? ud.center?.[1];
    const wMeta = meta.width ?? ud.width;
    const lMeta = meta.length ?? ud.length;

    const haveMeta =
      Number.isFinite(cxMeta) &&
      Number.isFinite(czMeta) &&
      Number.isFinite(wMeta) &&
      Number.isFinite(lMeta);

    if (haveMeta) {
      const cx = snap(Number(cxMeta));
      const cz = snap(Number(czMeta));
      const w = Number(wMeta);
      const l = Number(lMeta);
      const hw = w / 2;
      const hl = l / 2;

      const ring: Ring2 = [
        [snap(cx - hw), snap(cz - hl)],
        [snap(cx + hw), snap(cz - hl)],
        [snap(cx + hw), snap(cz + hl)],
        [snap(cx - hw), snap(cz + hl)],
        [snap(cx - hw), snap(cz - hl)],
      ];
      return [ring];
    }
    // kalau meta-nya nggak lengkap → fallback ke bounding box
  }

  // ------------------ POLY ------------------
  if (kind === "poly") {
    const outerRaw = meta.vertices ?? ud.vertices;
    const outerRing = parseRing2D(outerRaw);
    if (outerRing.length < 3) return null;

    const holes = parseHoles2D(meta.holes ?? ud.polyHoles ?? ud.holes)
      .map(ensureClosedRing)
      .filter((ring) => ring.length >= 4);

    return [ensureClosedRing(outerRing), ...holes];
  }

  // ------------------ Fallback: bounding box (WORLD) ------------------
  const box = new THREE.Box3().setFromObject(mesh);
  const min = box.min;
  const max = box.max;

  const ring: Ring2 = [
    [snap(min.x), snap(min.z)],
    [snap(max.x), snap(min.z)],
    [snap(max.x), snap(max.z)],
    [snap(min.x), snap(max.z)],
    [snap(min.x), snap(min.z)],
  ];
  return [ring];
}

// --------------------------------------------------------
// Mesh helpers (edges, dispose, build floor from ring)
// --------------------------------------------------------

/** Tambah edgeWire tipis ke mesh (dipakai juga di finalizePreview) */
export function addEdgeWireToMesh(mesh: THREE.Mesh) {
  try {
    const existing = (mesh.children || []).find(
      (c) => c.name === "__edgeWire"
    ) as THREE.LineSegments | undefined;

    if (existing) {
      mesh.remove(existing);
      (existing.geometry as any)?.dispose?.();
      (existing.material as any)?.dispose?.();
    }
    const baseGeometry = mesh.geometry as THREE.BufferGeometry;
    const position = baseGeometry.getAttribute("position") as THREE.BufferAttribute | undefined;

    let edges: THREE.EdgesGeometry;
    if (position) {
      const temp = new THREE.BufferGeometry();
      temp.setAttribute("position", position);
      if (baseGeometry.index) temp.setIndex(baseGeometry.index);

      const welded = mergeVertices(temp, 1e-4);
      temp.dispose();
      edges = new THREE.EdgesGeometry(welded, 25);
      welded.dispose();
    } else {
      edges = new THREE.EdgesGeometry(baseGeometry, 25);
    }
    const mat = new THREE.LineBasicMaterial({
      color: 0x1f1f1f,
      depthTest: false,
      depthWrite: false,
    });
    const wire = new THREE.LineSegments(edges, mat);
    wire.name = "__edgeWire";
    wire.renderOrder = 2;
    mesh.add(wire);
    (mesh.userData as any).edgeHelper = wire;
  } catch {
    /* noop */
  }
}

/** Dispose mesh beserta seluruh subtree geometry/material-nya */
function disposeMesh(mesh: THREE.Mesh) {
  try {
    disposeObjectDeep(mesh);
  } catch {
    /* noop */
  }
}

/**
 * Build satu mesh floor dari ring 2D (di plane XZ).
 * Semua hasil boolean akan jadi mode "poly".
 */
function buildFloorMeshFromRing(
  ring: Ring2D,
  opts: {
    depth: number;
    planeY?: number;
    fillColor?: number;
    fillOpacity?: number;
  }
): THREE.Mesh {
  const safeRing = cleanRingForGeometry(ring);
  const shape = new THREE.Shape(
    safeRing.map(([x, z]) => new THREE.Vector2(x, -z))
  );
  let geom: THREE.BufferGeometry;

  if (opts.depth && opts.depth > 0) {
    geom = new THREE.ExtrudeGeometry(shape, {
      depth: opts.depth,
      bevelEnabled: false,
    });
  } else {
    geom = new THREE.ShapeGeometry(shape);
  }

  // Ground XZ → rotate ke Y-up
  geom.rotateX(-Math.PI / 2);

  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (bb) {
    const offsetY = -bb.min.y;
    geom.translate(0, offsetY, 0);
  }

  const mat = createPhongMaterial({
    color: opts.fillColor ?? 0xffffff,
    transparent: false,
    opacity: 1,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = Number.isFinite(opts.planeY) ? Number(opts.planeY) : SURFACE_OFFSET;

  // Hitung center & simpan meta poly
  const bbox = new THREE.Box3().setFromObject(mesh);
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;

  mesh.userData.type = "surface";
  mesh.userData.mode = "poly";
  mesh.userData.label = "Polygon";
  mesh.userData.category = "Plane/Sketch";
  mesh.userData.QreaseeCategory = "Floor";
  mesh.userData.selectable = true;
  mesh.userData.locked = false;
  // mesh.userData.IFCClass = fallbackMapIFC["Floor"];
  const storedRing = ensureClosedRing(ring);
  mesh.userData.surfaceMeta = {
    kind: "poly",
    center: [cx, cz],
    vertices: storedRing,
  };
  mesh.userData.polyVertices = storedRing.map(([x, z]) => ({ x, z }));
  mesh.userData.depth = opts.depth ?? 0;

  return mesh;
}

function buildFloorMeshFromPoly(
  poly: Poly2,
  opts: {
    depth: number;
    planeY?: number;
    fillColor?: number;
    fillOpacity?: number;
  }
): THREE.Mesh | null {
  if (!poly.length || !poly[0] || poly[0].length < 3) return null;

  const outer = cleanRingForGeometry(poly[0]);
  if (outer.length < 3) return null;

  const shape = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));

  for (const hole of poly.slice(1)) {
    const holeRing = cleanRingForGeometry(hole);
    if (holeRing.length < 3) continue;
    const holePath = new THREE.Path(holeRing.map(([x, z]) => new THREE.Vector2(x, -z)));
    shape.holes.push(holePath);
  }

  let geom: THREE.BufferGeometry;
  if (opts.depth && opts.depth > 0) {
    geom = new THREE.ExtrudeGeometry(shape, {
      depth: opts.depth,
      bevelEnabled: false,
    });
  } else {
    geom = new THREE.ShapeGeometry(shape);
  }

  // Ground XZ → rotate ke Y-up
  geom.rotateX(-Math.PI / 2);

  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (bb) {
    const offsetY = -bb.min.y;
    geom.translate(0, offsetY, 0);
  }

  const opacity = Number.isFinite(opts.fillOpacity)
    ? THREE.MathUtils.clamp(Number(opts.fillOpacity), 0, 1)
    : 1;

  const mat = createPhongMaterial({
    color: opts.fillColor ?? 0xffffff,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = Number.isFinite(opts.planeY) ? Number(opts.planeY) : SURFACE_OFFSET;

  // Hitung center & simpan meta poly (outer + holes)
  const bbox = new THREE.Box3().setFromObject(mesh);
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;

  const storedOuter = ensureClosedRing(poly[0]);
  const storedHoles = poly
    .slice(1)
    .map(ensureClosedRing)
    .filter((ring) => ring.length >= 4);

  mesh.userData.type = "surface";
  mesh.userData.mode = "poly";
  mesh.userData.label = "Polygon";
  mesh.userData.category = "Plane/Sketch";
  mesh.userData.QreaseeCategory = "Floor";
  mesh.userData.selectable = true;
  mesh.userData.locked = false;
  mesh.userData.surfaceMeta = {
    kind: "poly",
    center: [cx, cz],
    vertices: storedOuter,
    ...(storedHoles.length ? { holes: storedHoles } : {}),
  };
  mesh.userData.polyVertices = storedOuter.map(([x, z]) => ({ x, z }));
  if (storedHoles.length) {
    mesh.userData.polyHoles = storedHoles.map((ring) => ring.map(([x, z]) => ({ x, z })));
  }
  mesh.userData.depth = opts.depth ?? 0;

  return mesh;
}

/**
 * Tambah outline tebal di atas ring floor (dipakai hasil split/restore).
 * Outline ini berupa box tipis per-segmen dan dipasang sebagai child mesh floor
 * supaya ikut kehapus kalau floor-nya dihapus.
 */
function addOutlineFromRing(parent: THREE.Mesh, ring: Ring2D) {
  try {
    const closed = ensureClosedRing(ring);
    if (!closed || closed.length < 2) return;

    // Buang titik penutup duplikat & rapihin duplikat berurutan biar outline gak "pecah".
    const raw = cleanRingForGeometry(closed);
    if (raw.length < 2) return;

    const pts: THREE.Vector3[] = [];
    let last: THREE.Vector3 | null = null;
    for (const [x, z] of raw) {
      const p = new THREE.Vector3(x, 0, z);
      if (last && p.distanceToSquared(last) < 1e-10) continue;
      pts.push(p);
      last = p;
    }
    if (pts.length < 2) return;

    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: 0x000000,
      depthTest: true,
      depthWrite: false,
    });
    const outline = new THREE.LineLoop(geom, mat);
    outline.renderOrder = 3;
    outline.position.y = OUTLINE_OFFSET;

    (outline.userData as any) = {
      ...(outline.userData || {}),
      type: "line",
      selectable: false,
      isHelper: true,
      isFloorOutline: true,
      isConnection: false,
      locked: true,
    };

    parent.add(outline);
  } catch {
    /* noop */
  }
}

// --------------------------------------------------------
// Floor split by new rect (lama, dipakai di flow existing)
// --------------------------------------------------------
export function splitFloorsWithNewRect(
  scene: THREE.Scene,
  newRectMesh: THREE.Mesh,
  opts: { depth: number; fillColor?: number; fillOpacity?: number }
): THREE.Mesh[] {
  const newPoly = normalizeMultiPoly(meshSurfaceToPoly2D(newRectMesh));
  if (isEmptyMultiPoly(newPoly)) return [];

  const levelTolerance = 1e-3;
  newRectMesh.updateWorldMatrix(true, true);
  const boxNew = new THREE.Box3().setFromObject(newRectMesh);
  const planeYTarget = (boxNew.min.y + boxNew.max.y) / 2;

  // di sini kita yakin newPoly bukan null lagi → pakai !
  let remainingNew: MultiPoly = newPoly!;

  // Ambil semua floor existing (type === 'surface' & QreaseeCategory === 'Floor')
  const existing: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    const anyObj = obj as any;
    if (!anyObj.isMesh) return;
    if (obj === newRectMesh) return;
    const ud: any = obj.userData || {};
    if (ud.type !== "surface") return;
    if (ud.isExtruded === true) return;
    if (ud.QreaseeCategory && ud.QreaseeCategory !== "Floor") return;
    const kind = ud.surfaceMeta?.kind;
    if (kind !== "rect" && kind !== "poly" && kind !== "circle") return;

    (anyObj as THREE.Object3D).updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(anyObj as THREE.Object3D);
    const yMid = (box.min.y + box.max.y) / 2;
    if (Math.abs(yMid - planeYTarget) > levelTolerance) return;

    existing.push(anyObj as THREE.Mesh);
  });

  const regions: { poly: MultiPoly; depth: number }[] = [];

  for (const em of existing) {
    const oldPoly = normalizeMultiPoly(meshSurfaceToPoly2D(em));
    if (isEmptyMultiPoly(oldPoly)) {
      continue;
    }

    // oldPoly sudah dicek, jadi pakai non-null assertion
    const inter = normalizeMultiPoly(
      pc.intersection(oldPoly!, remainingNew) as MultiPoly
    );
    const hasInter = !isEmptyMultiPoly(inter);

    if (!hasInter) {
      regions.push({
        poly: oldPoly!, // di sini juga perlu !
        depth: (em.userData as any).depth ?? 0,
      });
      continue;
    }

    const onlyOld = normalizeMultiPoly(
      pc.difference(oldPoly!, remainingNew) as MultiPoly
    );
    const onlyNew = normalizeMultiPoly(
      pc.difference(remainingNew, oldPoly!) as MultiPoly
    );

    if (!isEmptyMultiPoly(onlyOld)) {
      regions.push({
        poly: onlyOld,
        depth: (em.userData as any).depth ?? 0,
      });
    }

    if (!isEmptyMultiPoly(inter)) {
      const d = Math.max(
        (em.userData as any).depth ?? 0,
        opts.depth ?? 0
      );
      regions.push({
        poly: inter,
        depth: d,
      });
    }

    remainingNew = onlyNew;
  }

  // Sisa area rect baru yang tidak kena apapun
  if (!isEmptyMultiPoly(remainingNew)) {
    regions.push({
      poly: remainingNew,
      depth: opts.depth ?? 0,
    });
  }

  // Hapus semua mesh lama + rect baru
  for (const em of existing) {
    scene.remove(em);
    disposeMesh(em);
  }
  scene.remove(newRectMesh);
  disposeMesh(newRectMesh);

  // Bangun ulang semua region jadi mesh baru
  const created: THREE.Mesh[] = [];
  for (const region of regions) {
    for (const poly of region.poly) {
      if (!poly.length || !poly[0] || poly[0].length < 3) continue;
      const mesh =
        poly.length > 1
          ? buildFloorMeshFromPoly(poly, {
              depth: region.depth,
              planeY: planeYTarget,
              fillColor: opts.fillColor,
              fillOpacity: opts.fillOpacity,
            })
          : buildFloorMeshFromRing(poly[0], {
              depth: region.depth,
              planeY: planeYTarget,
              fillColor: opts.fillColor,
              fillOpacity: opts.fillOpacity,
            });
      if (!mesh) continue;
      scene.add(mesh);
      created.push(mesh);
      for (const ring of poly) {
        addOutlineFromRing(mesh, ring);
      }
    }
  }

  return created;
}

// --------------------------------------------------------
// Polygon-clipping helpers untuk overlay/partition (union style)
// --------------------------------------------------------

function cloneRing(r: Ring2): Ring2 {
  return r.map(([x, y]) => [snap(x), snap(y)]);
}
function clonePoly(p: Poly2): Poly2 {
  return p.map(cloneRing);
}
function mpToMultiPoly2(mp: MultiPolygon | any): MultiPoly2 {
  if (!mp || !Array.isArray(mp) || !mp.length) return [];
  return (mp as any as MultiPoly2).map((poly) =>
    poly.map((ring) =>
      ring.map(([x, y]: [number, number]) =>
        [snap(x), snap(y)] as [number, number]
      )
    )
  );
}

/**
 * Overlay / partition: ambil semua poligon, pecah jadi kepingan-kepingan
 * non-overlap yang mengikuti semua garis batas.
 *
 * Ini yang bikin hasilnya lebih mirip “ng-split” di SketchUp.
 */
function overlayPolygons(polys: MultiPoly2): MultiPoly2 {
  if (!polys.length) return [];

  let acc: MultiPoly2 = [clonePoly(polys[0])];

  for (let i = 1; i < polys.length; i++) {
    const next = clonePoly(polys[i]);
    acc = addAndSplit(acc, next);
  }

  return acc;
}

// bagi kumpulan kepingan "current" dengan poligon "next"
function addAndSplit(current: MultiPoly2, next: Poly2): MultiPoly2 {
  let result: MultiPoly2 = [];
  // nextRemaining: bagian dari "next" yang belum kena pecah sama sekali
  let nextRemainingMP: MultiPolygon = next as any;

  for (const cur of current) {
    const curMP: MultiPolygon = cur as any;

    // bagian yang overlap antara cur & next
    const interMP = pc.intersection(curMP, nextRemainingMP) as MultiPolygon;
    const inter = mpToMultiPoly2(interMP);

    // bagian cur di luar next
    const curDiffMP = pc.difference(curMP, nextRemainingMP) as MultiPolygon;
    const curDiff = mpToMultiPoly2(curDiffMP);

    // potong nextRemaining dengan cur, untuk mengurangi yang sudah diambil
    const nextDiffMP = pc.difference(nextRemainingMP, curMP) as MultiPolygon;
    const nextDiff = mpToMultiPoly2(nextDiffMP);
    nextRemainingMP = nextDiff as any as MultiPolygon;

    // cur sekarang pecah jadi curDiff + inter
    result = result.concat(curDiff, inter);
  }

  // apapun sisa dari next (di area yang belum ada kepingan lain) ikut jadi kepingan baru
  const leftover = mpToMultiPoly2(nextRemainingMP);
  result = result.concat(leftover);

  return result;
}

// --------------------------------------------------------
// Konversi Poly2 → THREE.Shape + mesh builder untuk coplanar surfaces
// --------------------------------------------------------

// Convert polygon-clipping -> THREE.Shape(s)
function polygonToShapes2D(poly: Poly2): THREE.Shape[] {
  if (!poly.length) return [];
  const [outer, ...holes] = poly;
  const shape = new THREE.Shape();

  outer.forEach(([x, z], i) => {
    const sx = snap(x);
    const sz = snap(z);
    if (i === 0) shape.moveTo(sx, sz);
    else shape.lineTo(sx, sz);
  });

  for (const ring of holes) {
    if (!ring.length) continue;
    const holePath = new THREE.Path();
    ring.forEach(([x, z], i) => {
      const sx = snap(x);
      const sz = snap(z);
      if (i === 0) holePath.moveTo(sx, sz);
      else holePath.lineTo(sx, sz);
    });
    shape.holes.push(holePath);
  }

  return [shape];
}

// Build mesh baru dari satu polygon (satu L-shape, dsb)
function buildSurfaceMeshFromPoly(
  poly: Poly2,
  template: THREE.Mesh,
  planeY: number
): THREE.Mesh | null {
  const shapes = polygonToShapes2D(poly);
  if (!shapes.length) return null;

  const geom2d = new THREE.ShapeGeometry(shapes);
  // ShapeGeometry default di bidang XY, kita mau XZ → rotateX(-90°)
  geom2d.rotateX(-Math.PI / 2);

  const sourceMaterial = template.material as THREE.Material | THREE.Material[];
  const material = Array.isArray(sourceMaterial)
    ? sourceMaterial.map((mat) => cloneAsPhongMaterial(mat))
    : cloneAsPhongMaterial(sourceMaterial);
  const mesh = new THREE.Mesh(geom2d, material);
  mesh.position.set(0, planeY, 0);

  const baseMeta = (template.userData.surfaceMeta || {}) as any;

  mesh.userData = {
    ...template.userData,
    rectGroupId: undefined, // jangan warisi, karena ini hasil pecahan/merge
    mode: "poly",
    type: "surface",
    surfaceMeta: {
      ...baseMeta,
      kind: "poly",
      vertices: shapes[0].getPoints().map((p) => ({
        x: snap(p.x),
        y: snap(planeY),
        z: snap(p.y),
      })),
      normal: { x: 0, y: 1, z: 0 },
    },
  };

  return mesh;
}

// --------------------------------------------------------
// Public API: clipCoplanarSurfacesAroundTarget
// --------------------------------------------------------

/**
 * Merge / split semua surface coplanar yang overlap dengan target.
 *
 * op:
 *  - "union"        → pecah jadi kepingan partitisi (lebih mirip SketchUp split)
 *  - "difference"   → sama seperti sebelumnya: target - others
 *  - "intersection" → hanya area irisan
 */
export function clipCoplanarSurfacesAroundTarget(
  scene: THREE.Scene,
  target: THREE.Mesh,
  op: "union" | "difference" | "intersection" = "union"
) {
  const targetPoly = meshToPolygon2D(target);
  if (!targetPoly) return;

  const udTarget: any = target.userData || {};
  const levelTolerance = 1e-3;

  // Y plane dari target (world)
  const boxTarget = new THREE.Box3().setFromObject(target);
  const yMidTarget = (boxTarget.min.y + boxTarget.max.y) / 2;

  // kalau punya meta level, pakai itu sebagai "key" level
  const levelKeyTarget =
    udTarget.surfaceMeta?.level ?? udTarget.level ?? snap(yMidTarget);

  const planeY = snap(
    typeof levelKeyTarget === "number" ? levelKeyTarget : yMidTarget
  );

  // Kumpulkan kandidat lain yang coplanar
  const polys: MultiPoly2 = [targetPoly];
  const meshes: THREE.Mesh[] = [target];

  scene.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!(m as any).isMesh || m === target) return;

    const ud: any = m.userData || {};

    const isSurface =
      ud.type === "surface" ||
      ud.mode === "rect" ||
      ud.mode === "poly" ||
      ud.surfaceMeta?.kind === "rect" ||
      ud.surfaceMeta?.kind === "poly";

    if (!isSurface) return;

    const box = new THREE.Box3().setFromObject(m);
    const yMid = (box.min.y + box.max.y) / 2;
    const levelKey = ud.surfaceMeta?.level ?? ud.level ?? snap(yMid);
    if (Math.abs(levelKey - levelKeyTarget) > levelTolerance) return;

    const poly = meshToPolygon2D(m);
    if (!poly) return;

    polys.push(poly);
    meshes.push(m);
  });

  if (polys.length <= 1) return;

  let resultPolys: MultiPoly2 = [];

  if (op === "union") {
    // partition semua kepingan di level itu → lebih mirip “split”
    resultPolys = overlayPolygons(polys);
  } else {
    // format MultiPolygon buat op lain yang masih CSG biasa
    const targetMP: MultiPolygon = targetPoly as any;
    const othersMP: MultiPolygon[] = polys
      .slice(1)
      .map((p) => p as any as MultiPolygon);

    let result: MultiPolygon;
    if (op === "difference") {
      result = pc.difference(targetMP, ...(othersMP as any)) as MultiPolygon;
    } else {
      result = pc.intersection(targetMP, ...(othersMP as any)) as MultiPolygon;
    }
    resultPolys = mpToMultiPoly2(result);
  }

  // Hapus mesh lama (semua kandidat di level itu)
  const toRemove = new Set<THREE.Object3D>(meshes);
  for (const obj of toRemove) {
    scene.remove(obj);
    disposeObjectDeep(obj);
  }

  // Tambah mesh baru dari result
  for (const poly of resultPolys) {
    const mesh = buildSurfaceMeshFromPoly(poly, target, planeY);
    if (mesh) scene.add(mesh);
  }
}

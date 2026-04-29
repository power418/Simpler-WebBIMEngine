import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getCoplanarFaceRegionLocalToRoot, type FaceRegion, type FaceTriangle } from "../utils/faceRegion";
import { GENERATED_PHONG_MATERIAL_KEY } from "../utils/materials";

type ColorMaterial = THREE.Material & { color?: THREE.Color };

export type FaceSelectionOptions = {
  scene: THREE.Scene;
  faceObject: THREE.Mesh;
  objectGeometry: THREE.BufferGeometry;
  faceMaterials: ColorMaterial[];
  faceBaseColor: number;
  faceHoverColor: number;
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  getCamera?: () => THREE.Camera;
  dotSpacing?: number;
  surfaceOffset?: number;
  dotColor?: number;
  dotSize?: number;
  borderColor?: number;
  borderLineWidth?: number;
};

type FaceSelectionItem = {
  object: THREE.Object3D;
  normal?: THREE.Vector3;
  region?: FaceRegion;
};

export function setupFaceSelection(options: FaceSelectionOptions) {
  const {
    scene,
    faceObject,
    objectGeometry,
    faceMaterials,
    faceBaseColor,
    // faceHoverColor,
    canvas,
    camera,
  } = options;

  const getActiveCamera = options.getCamera ?? (() => camera);

  const DOT_SPACING = options.dotSpacing ?? 0.03;
  const SURFACE_OFFSET = options.surfaceOffset ?? 0.001;
  const dotColor = options.dotColor ?? 0x0000ff;
  const dotSize = options.dotSize ?? 2;
  const borderColor = options.borderColor ?? 0x0000ff;
  const borderLineWidth = options.borderLineWidth ?? 4;

  objectGeometry.computeBoundingBox();
  const objectBounds = objectGeometry.boundingBox;
  if (!objectBounds) throw new Error("Object bounding box tidak tersedia");
  const objectBox: THREE.Box3 = objectBounds;

  const dotsMaterial = new THREE.PointsMaterial({
    color: dotColor,
    size: dotSize,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false,
  });
  const faceBorderMaterial = new LineMaterial({
    color: borderColor,
    linewidth: borderLineWidth,
    depthTest: false,
    depthWrite: false,
  });

  const boundsBoxWorld = new THREE.Box3();
  const boundsBoxLocal = new THREE.Box3();
  const boundsInverseMatrix = new THREE.Matrix4();
  const boundsCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
  const edgesPositionsCache = new WeakMap<THREE.BufferGeometry, Float32Array>();
  const tempChildBox = new THREE.Box3();

  function getEdgesPositions(geometry: THREE.BufferGeometry): Float32Array {
    const cached = edgesPositionsCache.get(geometry);
    if (cached) return cached;

    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!position) return new Float32Array();

    // Weld vertices so triangulation edges don't appear in EdgesGeometry.
    // (Indexed geometries can still have duplicated vertices after CSG/extrude.)
    const temp = new THREE.BufferGeometry();
    temp.setAttribute("position", position);
    if (geometry.index) temp.setIndex(geometry.index);

    const welded = mergeVertices(temp, 1e-4);
    temp.dispose();

    const edges = new THREE.EdgesGeometry(welded, 25);
    const positions = (edges.attributes.position.array as Float32Array).slice();
    edges.dispose();
    welded.dispose();

    edgesPositionsCache.set(geometry, positions);
    return positions;
  }

  function getLocalBounds(object: THREE.Object3D): THREE.Box3 | null {
    // Prefer geometry bounds for meshes (accurate in local space).
    if ((object as any).isMesh) {
      const mesh = object as THREE.Mesh;
      const geom = mesh.geometry as THREE.BufferGeometry | undefined;
      if (geom) {
        if (!geom.boundingBox) geom.computeBoundingBox();
        if (geom.boundingBox) return geom.boundingBox.clone();
      }
    }

    // Fallback: world AABB converted into object-local space (works for groups/lines).
    // Exclude helper overlays; otherwise the selection overlay becomes part of the
    // measured bounds and can "grow" every pointer move.
    object.updateWorldMatrix(true, true);

    const isUnderHelper = (obj: THREE.Object3D) => {
      let current: THREE.Object3D | null = obj;
      while (current) {
        if ((current.userData as any)?.isHelper) return true;
        current = current.parent;
      }
      return false;
    };

    boundsBoxWorld.makeEmpty();
    object.traverse((child) => {
      if (child.name === "SkyDome" || child.name === "Grid" || child.name === "AxesWorld") return;
      if (isUnderHelper(child)) return;

      if ((child as any).isMesh) {
        const mesh = child as THREE.Mesh;
        const geom = mesh.geometry as THREE.BufferGeometry | undefined;
        if (!geom) return;
        if (!geom.boundingBox) geom.computeBoundingBox();
        if (!geom.boundingBox) return;
        tempChildBox.copy(geom.boundingBox).applyMatrix4(mesh.matrixWorld);
        boundsBoxWorld.union(tempChildBox);
        return;
      }

      if ((child as any).isLine || (child as any).isLineSegments || (child as any).isPoints) {
        const geom = (child as any).geometry as THREE.BufferGeometry | undefined;
        if (!geom) return;
        const pos = geom.getAttribute("position") as THREE.BufferAttribute | undefined;
        if (!pos) return;
        tempChildBox.setFromBufferAttribute(pos).applyMatrix4(child.matrixWorld);
        boundsBoxWorld.union(tempChildBox);
      }
    });

    if (boundsBoxWorld.isEmpty()) return null;

    boundsInverseMatrix.copy(object.matrixWorld).invert();

    const min = boundsBoxWorld.min;
    const max = boundsBoxWorld.max;
    boundsCorners[0].set(min.x, min.y, min.z).applyMatrix4(boundsInverseMatrix);
    boundsCorners[1].set(min.x, min.y, max.z).applyMatrix4(boundsInverseMatrix);
    boundsCorners[2].set(min.x, max.y, min.z).applyMatrix4(boundsInverseMatrix);
    boundsCorners[3].set(min.x, max.y, max.z).applyMatrix4(boundsInverseMatrix);
    boundsCorners[4].set(max.x, min.y, min.z).applyMatrix4(boundsInverseMatrix);
    boundsCorners[5].set(max.x, min.y, max.z).applyMatrix4(boundsInverseMatrix);
    boundsCorners[6].set(max.x, max.y, min.z).applyMatrix4(boundsInverseMatrix);
    boundsCorners[7].set(max.x, max.y, max.z).applyMatrix4(boundsInverseMatrix);

    boundsBoxLocal.makeEmpty();
    for (const corner of boundsCorners) boundsBoxLocal.expandByPoint(corner);
    return boundsBoxLocal.clone();
  }

  function createBoxEdgeSegmentPositions(box: THREE.Box3): number[] {
    const min = box.min;
    const max = box.max;

    const c000 = new THREE.Vector3(min.x, min.y, min.z);
    const c100 = new THREE.Vector3(max.x, min.y, min.z);
    const c101 = new THREE.Vector3(max.x, min.y, max.z);
    const c001 = new THREE.Vector3(min.x, min.y, max.z);

    const c010 = new THREE.Vector3(min.x, max.y, min.z);
    const c110 = new THREE.Vector3(max.x, max.y, min.z);
    const c111 = new THREE.Vector3(max.x, max.y, max.z);
    const c011 = new THREE.Vector3(min.x, max.y, max.z);

    const positions: number[] = [];
    const pushSeg = (a: THREE.Vector3, b: THREE.Vector3) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };

    // Bottom
    pushSeg(c000, c100);
    pushSeg(c100, c101);
    pushSeg(c101, c001);
    pushSeg(c001, c000);
    // Top
    pushSeg(c010, c110);
    pushSeg(c110, c111);
    pushSeg(c111, c011);
    pushSeg(c011, c010);
    // Vertical
    pushSeg(c000, c010);
    pushSeg(c100, c110);
    pushSeg(c101, c111);
    pushSeg(c001, c011);
    return positions;
  }

  function updateBorderResolution() {
    const clientWidth = canvas.clientWidth;
    const clientHeight = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const width = clientWidth > 0 ? Math.round(clientWidth * dpr) : canvas.width;
    const height = clientHeight > 0 ? Math.round(clientHeight * dpr) : canvas.height;

    if (width <= 0 || height <= 0) return;
    faceBorderMaterial.resolution.set(width, height);
  }

  function createDotsGeometry(width: number, height: number, spacing: number) {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const positions: number[] = [];

    const xStart = -halfWidth + spacing / 2;
    const xEnd = halfWidth - spacing / 2;
    const yStart = -halfHeight + spacing / 2;
    const yEnd = halfHeight - spacing / 2;

    for (let x = xStart; x <= xEnd; x += spacing) {
      for (let y = yStart; y <= yEnd; y += spacing) {
        positions.push(x, y, 0);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );
    return geometry;
  }

  function createBorderGeometry(width: number, height: number) {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const positions = [
      -halfWidth, -halfHeight, 0, halfWidth, -halfHeight, 0,
      halfWidth, -halfHeight, 0, halfWidth, halfHeight, 0,
      halfWidth, halfHeight, 0, -halfWidth, halfHeight, 0,
      -halfWidth, halfHeight, 0, -halfWidth, -halfHeight, 0,
    ];

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    return geometry;
  }

  function createTriangleBorderGeometry(
    vertices: FaceTriangle,
    offset: number
  ) {
    const [a, b, c] = vertices;

    const normal = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
    normal.normalize();

    const o = normal.multiplyScalar(offset);
    const pA = a.clone().add(o);
    const pB = b.clone().add(o);
    const pC = c.clone().add(o);

    const segGeo = new LineSegmentsGeometry();
    segGeo.setPositions([
      pA.x, pA.y, pA.z, pB.x, pB.y, pB.z,
      pB.x, pB.y, pB.z, pC.x, pC.y, pC.z,
      pC.x, pC.y, pC.z, pA.x, pA.y, pA.z,
    ]);
    return segGeo;
  }

  function createTriangleDotsGeometry(
    vertices: FaceTriangle,
    spacing: number,
    offset: number
  ) {
    const [a, b, c] = vertices;
    const positions: number[] = [];

    const normal = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
    normal.normalize();

    if (!Number.isFinite(spacing) || spacing <= 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          [
            a.x, a.y, a.z,
            b.x, b.y, b.z,
            c.x, c.y, c.z,
          ],
          3
        )
      );
      return geometry;
    }

    const u = new THREE.Vector3().subVectors(b, a);
    if (u.lengthSq() < 1e-12) u.subVectors(c, a);
    if (u.lengthSq() < 1e-12) u.set(1, 0, 0);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();

    // 2D coords relative to a
    const bRel = new THREE.Vector3().subVectors(b, a);
    const cRel = new THREE.Vector3().subVectors(c, a);
    const bx = bRel.dot(u);
    const by = bRel.dot(v);
    const cx = cRel.dot(u);
    const cy = cRel.dot(v);

    const minX = Math.min(0, bx, cx);
    const maxX = Math.max(0, bx, cx);
    const minY = Math.min(0, by, cy);
    const maxY = Math.max(0, by, cy);

    const sign = (px: number, py: number, ax: number, ay: number, bx: number, by: number) =>
      (px - bx) * (ay - by) - (ax - bx) * (py - by);

    const pointInTri = (px: number, py: number) => {
      const b1 = sign(px, py, 0, 0, bx, by) < 0;
      const b2 = sign(px, py, bx, by, cx, cy) < 0;
      const b3 = sign(px, py, cx, cy, 0, 0) < 0;
      return b1 === b2 && b2 === b3;
    };

    const offsetVec = normal.clone().multiplyScalar(offset);
    const p = new THREE.Vector3();

    const xStart = minX + spacing / 2;
    const xEnd = maxX - spacing / 2;
    const yStart = minY + spacing / 2;
    const yEnd = maxY - spacing / 2;

    for (let x = xStart; x <= xEnd; x += spacing) {
      for (let y = yStart; y <= yEnd; y += spacing) {
        if (!pointInTri(x, y)) continue;
        p.copy(a)
          .addScaledVector(u, x)
          .addScaledVector(v, y)
          .add(offsetVec);
        positions.push(p.x, p.y, p.z);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  function createRegionBorderGeometry(triangles: FaceTriangle[], offset: number) {
    if (triangles.length === 1) return createTriangleBorderGeometry(triangles[0], offset);

    const [a, b, c] = triangles[0];
    const normal = new THREE.Vector3()
      .subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
    normal.normalize();
    const offsetVec = normal.multiplyScalar(offset);

    const positions: number[] = [];
    for (const tri of triangles) {
      positions.push(
        tri[0].x + offsetVec.x,
        tri[0].y + offsetVec.y,
        tri[0].z + offsetVec.z,
        tri[1].x + offsetVec.x,
        tri[1].y + offsetVec.y,
        tri[1].z + offsetVec.z,
        tri[2].x + offsetVec.x,
        tri[2].y + offsetVec.y,
        tri[2].z + offsetVec.z
      );
    }

    const temp = new THREE.BufferGeometry();
    temp.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const welded = mergeVertices(temp, 1e-4);
    temp.dispose();

    const edges = new THREE.EdgesGeometry(welded, 25);
    const segGeo = new LineSegmentsGeometry();
    segGeo.setPositions((edges.attributes.position.array as Float32Array).slice());
    edges.dispose();
    welded.dispose();
    return segGeo;
  }

  function createRegionDotsGeometry(triangles: FaceTriangle[], spacing: number, offset: number) {
    if (triangles.length === 1) return createTriangleDotsGeometry(triangles[0], spacing, offset);

    if (!Number.isFinite(spacing) || spacing <= 0) {
      const flat: number[] = [];
      for (const tri of triangles) {
        flat.push(
          tri[0].x, tri[0].y, tri[0].z,
          tri[1].x, tri[1].y, tri[1].z,
          tri[2].x, tri[2].y, tri[2].z
        );
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
      return geometry;
    }

    const [a0, b0, c0] = triangles[0];
    const normal = new THREE.Vector3()
      .subVectors(b0, a0)
      .cross(new THREE.Vector3().subVectors(c0, a0));
    if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
    normal.normalize();

    const u = new THREE.Vector3().subVectors(b0, a0);
    if (u.lengthSq() < 1e-12) u.subVectors(c0, a0);
    if (u.lengthSq() < 1e-12) u.set(1, 0, 0);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();

    const origin = a0.clone();

    const tris2d: Array<[number, number, number, number, number, number]> = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const to2d = (p: THREE.Vector3) => {
      const rel = new THREE.Vector3().subVectors(p, origin);
      const x = rel.dot(u);
      const y = rel.dot(v);
      return { x, y };
    };

    for (const tri of triangles) {
      const a = to2d(tri[0]);
      const b = to2d(tri[1]);
      const c = to2d(tri[2]);
      tris2d.push([a.x, a.y, b.x, b.y, c.x, c.y]);

      minX = Math.min(minX, a.x, b.x, c.x);
      maxX = Math.max(maxX, a.x, b.x, c.x);
      minY = Math.min(minY, a.y, b.y, c.y);
      maxY = Math.max(maxY, a.y, b.y, c.y);
    }

    const sign = (px: number, py: number, ax: number, ay: number, bx: number, by: number) =>
      (px - bx) * (ay - by) - (ax - bx) * (py - by);

    const pointInTri2d = (px: number, py: number, t: [number, number, number, number, number, number]) => {
      const [ax, ay, bx, by, cx, cy] = t;
      const b1 = sign(px, py, ax, ay, bx, by) < 0;
      const b2 = sign(px, py, bx, by, cx, cy) < 0;
      const b3 = sign(px, py, cx, cy, ax, ay) < 0;
      return b1 === b2 && b2 === b3;
    };

    const positions: number[] = [];
    const offsetVec = normal.clone().multiplyScalar(offset);
    const p3 = new THREE.Vector3();

    const xStart = minX + spacing / 2;
    const xEnd = maxX - spacing / 2;
    const yStart = minY + spacing / 2;
    const yEnd = maxY - spacing / 2;

    for (let x = xStart; x <= xEnd; x += spacing) {
      for (let y = yStart; y <= yEnd; y += spacing) {
        let inside = false;
        for (let i = 0; i < tris2d.length; i++) {
          if (pointInTri2d(x, y, tris2d[i])) {
            inside = true;
            break;
          }
        }
        if (!inside) continue;

        p3.copy(origin)
          .addScaledVector(u, x)
          .addScaledVector(v, y)
          .add(offsetVec);
        positions.push(p3.x, p3.y, p3.z);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }





  function getFaceInfoFromNormal(normal: THREE.Vector3, box: THREE.Box3) {
    const objectSize = new THREE.Vector3();
    box.getSize(objectSize);
    const objectCenter = new THREE.Vector3();
    box.getCenter(objectCenter);

    const absX = Math.abs(normal.x);
    const absY = Math.abs(normal.y);
    const absZ = Math.abs(normal.z);

    const faceCenter = new THREE.Vector3();
    const faceRotation = new THREE.Euler();
    const faceNormal = new THREE.Vector3();
    let faceWidth = 0;
    let faceHeight = 0;
    let axis: "x" | "y" | "z" = "z";

    if (absX >= absY && absX >= absZ) {
      axis = "x";
      const sign = normal.x >= 0 ? 1 : -1;
      faceNormal.set(sign, 0, 0);
      faceCenter.set(
        sign > 0 ? box.max.x : box.min.x,
        objectCenter.y,
        objectCenter.z
      );
      faceRotation.set(0, sign > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
      faceWidth = objectSize.z;
      faceHeight = objectSize.y;
    } else if (absY >= absX && absY >= absZ) {
      axis = "y";
      const sign = normal.y >= 0 ? 1 : -1;
      faceNormal.set(0, sign, 0);
      faceCenter.set(
        objectCenter.x,
        sign > 0 ? box.max.y : box.min.y,
        objectCenter.z
      );
      faceRotation.set(sign > 0 ? -Math.PI / 2 : Math.PI / 2, 0, 0);
      faceWidth = objectSize.x;
      faceHeight = objectSize.z;
    } else {
      axis = "z";
      const sign = normal.z >= 0 ? 1 : -1;
      faceNormal.set(0, 0, sign);
      faceCenter.set(
        objectCenter.x,
        objectCenter.y,
        sign > 0 ? box.max.z : box.min.z
      );
      faceRotation.set(0, sign > 0 ? 0 : Math.PI, 0);
      faceWidth = objectSize.x;
      faceHeight = objectSize.y;
    }

    return {
      axis,
      center: faceCenter,
      rotation: faceRotation,
      normal: faceNormal,
      width: faceWidth,
      height: faceHeight,
    };
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoveredObject: THREE.Object3D | null = null;
  // hoveredFaceIndex removed
  let hoveredFaceTriangleIndex: number | undefined = undefined;

  // State untuk multi-selection
  let currentSelection: FaceSelectionItem[] = [];
  const activeOverlays = new Map<number, { group: THREE.Group; dots: THREE.Points; border: LineSegments2 }>();

  // Hover Overlay
  const hoverOverlayGroup = new THREE.Group();
  hoverOverlayGroup.renderOrder = 4; // Higher than selection
  const hoverDots = new THREE.Points(new THREE.BufferGeometry(), dotsMaterial.clone());
  // White color for hover as requested "memutih"
  (hoverDots.material as THREE.PointsMaterial).color.setHex(0xffffff);
  hoverDots.renderOrder = 4;
  hoverOverlayGroup.add(hoverDots);

  const hoverBorder = new LineSegments2(new LineSegmentsGeometry(), faceBorderMaterial.clone());
  hoverBorder.material.color.setHex(0xffffff);
  hoverBorder.renderOrder = 5;
  hoverOverlayGroup.add(hoverBorder);

  // Helpers
  hoverOverlayGroup.userData.isHelper = true;
  hoverOverlayGroup.userData.selectable = false;
  scene.add(hoverOverlayGroup);

  let showSelectedBorder = false;

  function setPointerFromEvent(event: PointerEvent | MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pickFace() {
    // Raycast against selectable roots (imported roots are usually Groups, not Meshes).
    const candidates: THREE.Object3D[] = [faceObject];
    scene.traverse((obj) => {
      if (obj === faceObject) return;
      if ((obj.userData as any)?.selectable === true) candidates.push(obj);
    });

    const intersections = raycaster.intersectObjects(candidates, true);

    const isPickableHit = (hit: THREE.Intersection) => {
      const obj = hit.object as any;
      if (!obj) return false;
      if (obj.userData?.isHelper) return false;
      if (obj.userData?.selectable === false) return false;
      if (obj.name === "SkyDome" || obj.name === "Grid" || obj.name === "AxesWorld") return false;
      return true;
    };

    const intersection = intersections.find((hit) => {
      if (!isPickableHit(hit)) return false;
      const materialIndex = hit.face?.materialIndex;
      const normal = hit.face?.normal;
      return typeof materialIndex === "number" && !!normal;
    });

    if (!intersection) return null;

    const materialIndex = intersection.face!.materialIndex;
    const normal = intersection.face!.normal;
    const faceIndex = intersection.faceIndex;

    return { object: intersection.object, materialIndex, normal: normal.clone(), faceIndex };
  }

  function setFaceColor(object: THREE.Object3D, index: number, color: number) {
    if (object === faceObject) {
      const material = faceMaterials[index];
      if (!material) return;
      material.color?.set(color);
    } else if ((object as THREE.Mesh).isMesh) {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.Material | THREE.Material[];
      const target = Array.isArray(material) ? material[index] ?? material[0] : material;
      const colorMaterial = target as ColorMaterial | undefined;
      colorMaterial?.color?.set(color);
    }
  }

  function usesGeneratedPhongMaterial(object: THREE.Object3D) {
    if (!(object as any).isMesh) return false;
    const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[];
    const materials = Array.isArray(material) ? material : [material];
    return materials.some((mat) => (mat.userData as any)?.[GENERATED_PHONG_MATERIAL_KEY] === true);
  }

  function updateSelectEffect() {
    updateBorderResolution();

    for (let index = 0; index < faceMaterials.length; index++) {
      setFaceColor(faceObject, index, faceBaseColor);
    }
    scene.traverse((obj) => {
      if (obj !== faceObject && obj.userData.selectable && usesGeneratedPhongMaterial(obj)) {
        setFaceColor(obj, 0, faceBaseColor);
      }
    });

    // Highlight Hovered (hanya jika tidak sedang diseleksi)
    if (hoveredObject) {
      hoverOverlayGroup.visible = true;

      if (hoveredObject && (hoveredObject as THREE.Mesh).isMesh && typeof hoveredFaceTriangleIndex === 'number') {
        const mesh = hoveredObject as THREE.Mesh;

        // Use the helper to get the full coplanar region in World Space (root = scene)
        // We cast to THREE.Intersection as we only need object and faceIndex
        const fakeIntersection = {
          object: mesh,
          faceIndex: hoveredFaceTriangleIndex,
          distance: 0,
          point: new THREE.Vector3()
        } as unknown as THREE.Intersection;

        const region = getCoplanarFaceRegionLocalToRoot(fakeIntersection, scene);

        if (region) {
          hoverDots.geometry.dispose();
          hoverDots.geometry = createRegionDotsGeometry(region.triangles, DOT_SPACING, SURFACE_OFFSET * 2);

          hoverBorder.geometry.dispose();
          hoverBorder.geometry = createRegionBorderGeometry(region.triangles, SURFACE_OFFSET * 2);

          hoverBorder.material.resolution.set(canvas.width, canvas.height);
        } else {
          // Fallback: Just the single triangle if region failed (unlikely)
          const geometry = mesh.geometry;
          const getVertex = (index: number) => {
            const pos = geometry.attributes.position;
            return new THREE.Vector3(pos.getX(index), pos.getY(index), pos.getZ(index));
          };

          let vA: THREE.Vector3, vB: THREE.Vector3, vC: THREE.Vector3;
          if (geometry.index) {
            vA = getVertex(geometry.index.getX(hoveredFaceTriangleIndex * 3));
            vB = getVertex(geometry.index.getX(hoveredFaceTriangleIndex * 3 + 1));
            vC = getVertex(geometry.index.getX(hoveredFaceTriangleIndex * 3 + 2));
          } else {
            vA = getVertex(hoveredFaceTriangleIndex * 3);
            vB = getVertex(hoveredFaceTriangleIndex * 3 + 1);
            vC = getVertex(hoveredFaceTriangleIndex * 3 + 2);
          }

          vA.applyMatrix4(mesh.matrixWorld);
          vB.applyMatrix4(mesh.matrixWorld);
          vC.applyMatrix4(mesh.matrixWorld);

          const triangle: FaceTriangle = [vA, vB, vC];

          hoverDots.geometry.dispose();
          hoverDots.geometry = createRegionDotsGeometry([triangle], DOT_SPACING, SURFACE_OFFSET * 2);

          hoverBorder.geometry.dispose();
          hoverBorder.geometry = createRegionBorderGeometry([triangle], SURFACE_OFFSET * 2);
          hoverBorder.material.resolution.set(canvas.width, canvas.height);
        }
      }
    } else {
      hoverOverlayGroup.visible = false;
    }

    // Manage Overlays
    const newOverlayIds = new Set<number>();

    currentSelection.forEach((item) => {
      const obj = item.object;
      newOverlayIds.add(obj.id);

      let overlay = activeOverlays.get(obj.id);

      if (!overlay) {
        // Create new overlay
        const group = new THREE.Group();
        group.renderOrder = 2;

        const dots = new THREE.Points(new THREE.BufferGeometry(), dotsMaterial);
        dots.renderOrder = 2;
        group.add(dots);

        const border = new LineSegments2(new LineSegmentsGeometry(), faceBorderMaterial);
        border.renderOrder = 3;
        group.add(border);

        group.userData.isHelper = true;
        group.userData.selectable = false;
        obj.add(group);

        // Prevent overlays from interfering with scene raycasts.
        group.traverse((child) => {
          child.userData.isHelper = true;
          child.userData.selectable = false;
          (child as any).raycast = () => { };
        });

        overlay = { group, dots, border };
        activeOverlays.set(obj.id, overlay);
      }

      updateOverlayGeometry(obj, overlay, item.normal, item.region);

      // Update visibility
      overlay.group.visible = true;
      overlay.border.visible = showSelectedBorder;
    });

    // Cleanup old overlays
    for (const [id, overlay] of activeOverlays) {
      if (!newOverlayIds.has(id)) {
        overlay.group.removeFromParent();
        overlay.dots.geometry.dispose();
        overlay.border.geometry.dispose();
        activeOverlays.delete(id);
      }
    }
  }

  function updateOverlayGeometry(
    obj: THREE.Object3D,
    overlay: { dots: THREE.Points; border: LineSegments2; group: THREE.Group },
    normal?: THREE.Vector3,
    region?: FaceRegion
  ) {
    if (region) {
      overlay.group.position.set(0, 0, 0);
      overlay.group.rotation.set(0, 0, 0);
      overlay.group.scale.set(1, 1, 1);

      overlay.dots.visible = true;
      overlay.border.visible = true;

      overlay.dots.geometry.dispose();
      overlay.dots.geometry = createRegionDotsGeometry(region.triangles, DOT_SPACING, SURFACE_OFFSET);

      overlay.border.geometry.dispose();
      overlay.border.geometry = createRegionBorderGeometry(region.triangles, SURFACE_OFFSET);
      return;
    }

    if (obj === faceObject) {
      if (normal) {
        const faceInfo = getFaceInfoFromNormal(normal, objectBox);

        overlay.group.position
          .copy(faceInfo.center)
          .addScaledVector(faceInfo.normal, SURFACE_OFFSET);
        overlay.group.rotation.copy(faceInfo.rotation);

        overlay.dots.geometry.dispose();
        overlay.dots.geometry = createDotsGeometry(faceInfo.width, faceInfo.height, DOT_SPACING);

        overlay.border.geometry.dispose();
        overlay.border.geometry = createBorderGeometry(faceInfo.width, faceInfo.height);
      } else {
        // All faces logic for Object
        overlay.group.position.set(0, 0, 0);
        overlay.group.rotation.set(0, 0, 0);

        const allDotsPositions: number[] = [];
        const normals = [
          new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
          new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
        ];

        const v = new THREE.Vector3();
        normals.forEach(n => {
          const info = getFaceInfoFromNormal(n, objectBox);
          const dotsGeo = createDotsGeometry(info.width, info.height, DOT_SPACING);
          const posAttr = dotsGeo.getAttribute('position');
          const offset = n.clone().multiplyScalar(SURFACE_OFFSET);

          for (let i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i);
            v.applyEuler(info.rotation);
            v.add(info.center);
            v.add(offset);
            allDotsPositions.push(v.x, v.y, v.z);
          }
          dotsGeo.dispose();
        });

        const mergedDotsGeo = new THREE.BufferGeometry();
        mergedDotsGeo.setAttribute('position', new THREE.Float32BufferAttribute(allDotsPositions, 3));
        overlay.dots.geometry.dispose();
        overlay.dots.geometry = mergedDotsGeo;

        const lineGeo = new LineSegmentsGeometry();
        lineGeo.setPositions(getEdgesPositions(objectGeometry));
        overlay.border.geometry.dispose();
        overlay.border.geometry = lineGeo;
      }
    } else {
      const bounds = getLocalBounds(obj);
      if (!bounds) {
        overlay.dots.visible = false;
        overlay.border.visible = false;
        return;
      }

      const isMesh = (obj as any).isMesh === true;
      const mesh = isMesh ? (obj as THREE.Mesh) : null;

      if (normal) {
        // Single Face Selection (works for meshes and groups: use local AABB face)
        const faceInfo = getFaceInfoFromNormal(normal, bounds);

        overlay.group.position
          .copy(faceInfo.center)
          .addScaledVector(faceInfo.normal, SURFACE_OFFSET);
        overlay.group.rotation.copy(faceInfo.rotation);
        overlay.group.scale.set(1, 1, 1);

        overlay.dots.visible = true;
        overlay.border.visible = true;

        overlay.dots.geometry.dispose();
        overlay.dots.geometry = createDotsGeometry(faceInfo.width, faceInfo.height, DOT_SPACING);

        overlay.border.geometry.dispose();
        overlay.border.geometry = createBorderGeometry(faceInfo.width, faceInfo.height);
      } else {
        // Whole Object Selection (built-in): dots on all AABB faces + outline
        overlay.group.position.set(0, 0, 0);
        overlay.group.rotation.set(0, 0, 0);
        overlay.group.scale.set(1, 1, 1);
        overlay.dots.visible = true;
        overlay.border.visible = true;

        const allDotsPositions: number[] = [];
        const normals = [
          new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
          new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
        ];

        const v = new THREE.Vector3();
        for (const n of normals) {
          const info = getFaceInfoFromNormal(n, bounds);
          const dotsGeo = createDotsGeometry(info.width, info.height, DOT_SPACING);
          const posAttr = dotsGeo.getAttribute("position");
          const offset = n.clone().multiplyScalar(SURFACE_OFFSET);

          for (let i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i);
            v.applyEuler(info.rotation);
            v.add(info.center);
            v.add(offset);
            allDotsPositions.push(v.x, v.y, v.z);
          }
          dotsGeo.dispose();
        }

        const mergedDotsGeo = new THREE.BufferGeometry();
        mergedDotsGeo.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(allDotsPositions, 3)
        );
        overlay.dots.geometry.dispose();
        overlay.dots.geometry = mergedDotsGeo;

        overlay.border.geometry.dispose();

        if (mesh && mesh.geometry) {
          const lineGeo = new LineSegmentsGeometry();
          lineGeo.setPositions(getEdgesPositions(mesh.geometry));
          overlay.border.geometry = lineGeo;
        } else {
          const lineGeo = new LineSegmentsGeometry();
          lineGeo.setPositions(createBoxEdgeSegmentPositions(bounds));
          overlay.border.geometry = lineGeo;
        }
      }
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    setPointerFromEvent(event);
    raycaster.setFromCamera(pointer, getActiveCamera());

    const hit = pickFace();
    hoveredObject = hit?.object ?? null;
    hoveredObject = hit?.object ?? null;
    // hoveredFaceIndex = hit?.materialIndex ?? null;
    hoveredFaceTriangleIndex = hit?.faceIndex ?? undefined; // Capture the triangle face index
    canvas.style.cursor = hoveredObject ? "pointer" : "";
    updateSelectEffect();
  };

  const onPointerLeave = () => {
    hoveredObject = null;
    hoveredObject = null;
    // hoveredFaceIndex = null;
    hoveredFaceTriangleIndex = undefined;
    canvas.style.cursor = "";
    updateSelectEffect();
  };

  const onResize = () => {
    requestAnimationFrame(updateSelectEffect);
  };

  window.addEventListener("resize", onResize);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);

  const setSelectionByNormal = (normal: THREE.Vector3 | null, border = true) => {
    if (normal) {
      currentSelection = [{ object: faceObject, normal: normal.clone() }];
    } else {
      currentSelection = [];
    }
    showSelectedBorder = border && !!normal;
    showSelectedBorder = border && !!normal;
    hoveredObject = null;
    hoveredObject = null;
    // hoveredFaceIndex = null;
    hoveredFaceTriangleIndex = undefined;
    updateSelectEffect();
  };

  const setSelectedObjects = (items: FaceSelectionItem[]) => {
    currentSelection = items.map((item) => ({
      object: item.object,
      normal: item.normal ? item.normal.clone() : undefined,
      region: item.region
        ? {
          triangles: item.region.triangles.map(
            (tri) => [tri[0].clone(), tri[1].clone(), tri[2].clone()] as FaceTriangle
          ),
        }
        : undefined,
    }));
    showSelectedBorder = true; // Default show border for object selection
    updateSelectEffect();
  };

  const setHovered = (object: THREE.Object3D | null, _faceIndex: number | null) => {
    hoveredObject = object;
    // hoveredFaceIndex = faceIndex;
    canvas.style.cursor = hoveredObject ? "pointer" : "";
    updateSelectEffect();
  };

  updateSelectEffect();
  requestAnimationFrame(updateSelectEffect);

  return {
    updateSelectEffect,
    setSelectionByNormal,
    setSelectedObjects,
    setHovered,
    dispose() {
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);

      activeOverlays.forEach(overlay => {
        overlay.group.removeFromParent();
        overlay.dots.geometry.dispose();
        overlay.border.geometry.dispose();
      });
      activeOverlays.clear();
      hoverOverlayGroup.removeFromParent();
      hoverDots.geometry.dispose();
      hoverDots.material.dispose();
      hoverBorder.geometry.dispose();
      hoverBorder.material.dispose();
      dotsMaterial.dispose();
      faceBorderMaterial.dispose();
    },
  };
}

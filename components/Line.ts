import * as THREE from "three";
import { SnappingHelper, type SnapKind, type SnapResult } from "../helpers/snapping-helper";
import { IntersectionHelper, type IntersectionResult } from "../helpers/intersection-helper";
import { IntersectionGuide } from "../helpers/intersection-guide";
import { createPhongMaterial } from "../utils/materials";

type PickInfo = {
  point: THREE.Vector3;
  surfacePlane?: THREE.Plane;
};

export class LineTool {
  private scene: THREE.Scene;
  private getCamera: () => THREE.Camera;
  private container: HTMLElement;
  private onLineCreated?: (mesh: THREE.Object3D) => void;

  private enabled = false;
  private points: THREE.Vector3[] = [];
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // XZ (Y=ground)
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // Active drawing plane
  private planeLocked = false;
  private snappingHelper: SnappingHelper;
  private intersectionHelper: IntersectionHelper;
  private intersectionGuide: IntersectionGuide;

  // Visual Helpers
  private previewLine: THREE.Line | null = null;
  private connectorDot: THREE.Sprite | null = null;
  private axisGuides: THREE.Line[] = []; // Changed from single axisGuide to array
  private snapGuides: THREE.Group | null = null;
  private snapGuideLines: THREE.Line[] = [];
  private edgeGuide: THREE.Line | null = null;
  private axisInfoEl: HTMLDivElement | null = null;
  private inputEl: HTMLInputElement | null = null;

  // State
  private typedLength = "";
  private edgeLockDirs: THREE.Vector3[] = [];
  private tempVec3 = new THREE.Vector3();
  private tempVec3b = new THREE.Vector3();
  private createdFaceHashes = new Set<string>();
  private meshEdgesCache = new WeakMap<THREE.BufferGeometry, Map<number, THREE.EdgesGeometry>>();

  // Constants
  private readonly SNAP_THRESHOLD = 0.3;
  private readonly AXIS_SNAP_PIXELS = 15;

  private previewColor = new THREE.Color(0x000000); // Default to black

  public setPreviewColor(color: THREE.Color) {
    this.previewColor.copy(color);
    if (this.previewLine && this.previewLine.material) {
      const mat = this.previewLine.material as THREE.LineBasicMaterial;
      if (mat.color) mat.color.copy(this.previewColor);
    }
  }

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera | (() => THREE.Camera),
    container: HTMLElement,
    onLineCreated?: (mesh: THREE.Object3D) => void
  ) {
    this.scene = scene;
    this.getCamera = typeof camera === "function" ? camera : () => camera;
    this.container = container;
    this.onLineCreated = onLineCreated;
    this.snappingHelper = new SnappingHelper(
      this.scene,
      this.getCamera,
      this.container,
      this.raycaster,
      this.SNAP_THRESHOLD
    );
    this.intersectionHelper = new IntersectionHelper(
      this.getCamera,
      this.container
    );
    this.intersectionGuide = new IntersectionGuide(this.scene);
  }

  public enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.points = [];
    this.typedLength = "";
    this.edgeLockDirs = [];
    this.resetDrawingPlane();
    this.container.style.cursor = "crosshair";

    this.container.addEventListener("pointermove", this.onPointerMove);
    this.container.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("keydown", this.onKeyDown);
  }

  public disable() {
    if (!this.enabled) return;

    // When exiting the tool (e.g. via Escape/tool switch), don't discard the
    // already drawn points. Commit them as a line/mesh if possible.
    if (this.points.length > 0) {
      this.finalizeLine();
    }

    this.enabled = false;
    this.container.style.cursor = "default";

    this.container.removeEventListener("pointermove", this.onPointerMove);
    this.container.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("keydown", this.onKeyDown);

    this.cleanupVisuals();
    this.removeInputOverlay();
    this.hideAxisInfo();
  }

  private cleanupVisuals() {
    const removeObj = (obj: THREE.Object3D | null) => {
      if (obj) {
        obj.traverse((child) => {
          const anyChild = child as any;
          if (anyChild.geometry) anyChild.geometry.dispose();
          if (anyChild.material) {
            if (Array.isArray(anyChild.material)) {
              anyChild.material.forEach((m: any) => m.dispose());
            } else {
              anyChild.material.dispose();
            }
          }
        });
        this.scene.remove(obj);
      }
    };

    removeObj(this.previewLine);
    removeObj(this.connectorDot);
    this.axisGuides.forEach(g => removeObj(g));
    removeObj(this.snapGuides);
    removeObj(this.edgeGuide);

    this.previewLine = null;
    this.connectorDot = null;
    this.axisGuides = [];
    this.snapGuides = null;
    this.snapGuideLines = [];

  }

  // --- Event Handlers ---

  private onPointerMove = (e: PointerEvent) => {
    if (!this.enabled) return;

    // Skip jika sedang navigasi (Shift/Middle click)
    if (e.shiftKey && (e.buttons & 1) === 1) return;
    if ((e.buttons & 4) === 4) return;

    const pick = this.pickPoint(e);
    if (!pick) return;

    let target = pick.point.clone();
    let snappedAxis: "x" | "y" | "z" | null = null;
    let snappedEdgeDir: THREE.Vector3 | null = null;
    let intersectionResult: IntersectionResult | null = null;

    // 1. Snap ke Geometri (Endpoint/Midpoint)
    // Gunakan threshold angle rendah (1 derajat) untuk mendeteksi semua edge yang signifikan
    const rect = this.container.getBoundingClientRect();
    const mouseScreen = new THREE.Vector2(
      e.clientX - rect.left,
      e.clientY - rect.top
    );
    const snapResult = this.snappingHelper.getBestSnapByScreen(
      mouseScreen,
      this.points,
      this.AXIS_SNAP_PIXELS,
      { meshEdgeThresholdAngle: 1 }
    );
    if (snapResult) {
      target.copy(snapResult.point);
    }

    // 2. Axis Locking (Inference)
    let axisSnapLines: { axis: "x" | "y" | "z", origin: THREE.Vector3 }[] = [];

    if (!snapResult && this.points.length > 0) {
      const last = this.points[this.points.length - 1];
      const start = this.points[0];

      // Collect points from OTHER meshes in the scene for inference
      const scenePoints = this.snappingHelper.getSceneVertices({ limit: 200, ignoreIds: new Set(this.points.map(() => -1)) });
      const allCandidates = [...this.points, ...scenePoints];

      // Dual Axis Snap (Intersection)
      let dualSnap: THREE.Vector3 | null = null;
      if (allCandidates.length >= 2) {
        const result = this.intersectionHelper.getBestIntersection(
          last,
          allCandidates,
          mouseScreen,
          this.AXIS_SNAP_PIXELS
        );
        if (result) {
          dualSnap = result.point;
          target.copy(result.point);
          intersectionResult = result;
          axisSnapLines = [];
          snappedAxis = null;
        }
      }

      // Single Axis Snap
      if (!dualSnap) {
        const axes = [
          { name: "x" as const, dir: new THREE.Vector3(1, 0, 0) },
          { name: "z" as const, dir: new THREE.Vector3(0, 0, 1) },
          { name: "y" as const, dir: new THREE.Vector3(0, 1, 0) },
        ];

        let bestDist = this.AXIS_SNAP_PIXELS;
        let bestPoint: THREE.Vector3 | null = null;
        let bestAxis: { name: "x" | "y" | "z", dir: THREE.Vector3 } | null = null;

        for (const ax of axes) {
          const info = this.snappingHelper.getClosestPointOnAxis(last, ax.dir, mouseScreen);
          if (info.distPixels < bestDist) {
            bestDist = info.distPixels;
            bestPoint = info.point;
            bestAxis = ax;
            snappedAxis = ax.name;
            snappedEdgeDir = null;
            axisSnapLines = [{ axis: ax.name, origin: last }];
          }
        }

        if (!bestPoint && this.points.length > 1) {
          for (const ax of axes) {
            const info = this.snappingHelper.getClosestPointOnAxis(start, ax.dir, mouseScreen);
            if (info.distPixels < bestDist) {
              bestDist = info.distPixels;
              bestPoint = info.point;
              bestAxis = ax;
              snappedAxis = ax.name;
              snappedEdgeDir = null;
              axisSnapLines = [{ axis: ax.name, origin: start }];
            }
          }
        }

        if (bestPoint && bestAxis) {
          target.copy(bestPoint);

          // Raycast axis intersection against scene meshes
          const rayOrigin = axisSnapLines[0].origin;
          const rayDir = bestAxis.dir.clone();

          this.raycaster.set(rayOrigin, rayDir);
          const hitsPos = this.raycaster.intersectObjects(this.scene.children, true);

          this.raycaster.set(rayOrigin, rayDir.negate());
          const hitsNeg = this.raycaster.intersectObjects(this.scene.children, true);

          const validHits = [...hitsPos, ...hitsNeg].filter(h => {
            if (h.object.userData.isHelper) return false;
            if (h.object.name === "Grid" || h.object.name === "SkyDome") return false;
            if ((h.object as any).isLine) return false;
            return true;
          });

          let bestHitDist = Infinity;
          let bestHitPoint: THREE.Vector3 | null = null;

          for (const h of validHits) {
            const d = h.point.distanceTo(bestPoint);
            if (d < 0.5) {
              if (d < bestHitDist) {
                bestHitDist = d;
                bestHitPoint = h.point;
              }
            }
          }

          if (bestHitPoint) {
            target.copy(bestHitPoint);
          }
        }
      }

      if (!dualSnap && !snappedAxis) {
        for (const dir of this.edgeLockDirs) {
          const info = this.snappingHelper.getClosestPointOnAxis(last, dir, mouseScreen);
          if (info.distPixels < this.AXIS_SNAP_PIXELS) {
            target.copy(info.point);
            snappedAxis = null;
            snappedEdgeDir = dir;
            axisSnapLines = [];
          }
        }
      }
    }

    this.updateConnectorDot(target, snapResult?.kind);
    this.updateSnapGuides(snapResult);
    this.updateAxisGuides(axisSnapLines.length > 1 ? axisSnapLines : []);
    this.updateEdgeGuide(snappedEdgeDir, this.points[this.points.length - 1]);
    this.intersectionGuide.update(intersectionResult);
    this.updatePreviewLine(target); // Note: updatePreviewLine might need 'target' logic for axis lines? No, it just draws to target.
    if (this.points.length > 0) {
      const lockLabel = snappedAxis ? `Axis: ${snappedAxis.toUpperCase()}` : (snappedEdgeDir ? "Edge" : (axisSnapLines.length > 1 ? "Intersection" : null));
      this.updateAxisInfo(this.points[this.points.length - 1], target, lockLabel);
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return;

    // Cegah event bubbling agar tidak trigger orbit controls selection
    // e.stopPropagation(); 

    const pick = this.pickPoint(e);
    if (!pick) return;

    if (this.points.length === 0) {
      if (pick.surfacePlane) {
        this.plane.copy(pick.surfacePlane);
        this.planeLocked = true;
      } else {
        this.resetDrawingPlane();
      }
    }

    const rect = this.container.getBoundingClientRect();
    const mouseScreen = new THREE.Vector2(
      e.clientX - rect.left,
      e.clientY - rect.top
    );
    const clickSnap = this.snappingHelper.getBestSnapByScreen(
      mouseScreen,
      this.points,
      this.AXIS_SNAP_PIXELS
    );

    // Prioritaskan posisi dot connector yang sudah ter-snap/axis-locked
    let target = this.connectorDot ? this.connectorDot.position.clone() : pick.point.clone();

    // Close loop check
    if (this.points.length >= 2) {
      if (target.distanceTo(this.points[0]) < this.SNAP_THRESHOLD) {
        this.points.push(this.points[0].clone());
        this.finalizeLine();
        return;
      }
    }

    // Handle Typed Length
    if (this.points.length > 0 && this.typedLength) {
      const len = parseFloat(this.typedLength);
      if (isFinite(len) && len > 0) {
        const last = this.points[this.points.length - 1];
        const dir = new THREE.Vector3().subVectors(target, last).normalize();
        target = last.clone().addScaledVector(dir, len);
        this.typedLength = "";
        this.removeInputOverlay();
      }
    }

    const nextEdgeLockDirs = this.getEdgeLockDirsFromSnap(clickSnap, target);

    this.points.push(target);
    this.edgeLockDirs = nextEdgeLockDirs;
    // Keep the active plane passing through the latest point (SketchUp-like).
    this.plane.constant = -this.plane.normal.dot(target);

    // Buat bidang (face) langsung ketika edge baru membentuk loop dengan edge lain
    // (termasuk edge yang berasal dari mesh yang sudah ada).
    // (termasuk edge yang berasal dari mesh yang sudah ada).
    if (this.points.length >= 2) {
      try {
        this.tryAutoCreateFaces({ includeMeshEdges: true, extraPolyline: this.points });
      } catch (e) {
        console.error("Auto face creation failed (interactive):", e);
      }
    }

    if (this.points.length === 1) {
      this.showInputOverlay(e.clientX, e.clientY);
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled) return;

    if (e.key === "Enter") {
      if (this.points.length > 1) this.finalizeLine();
    } else if (e.key === "Backspace") {
      this.typedLength = this.typedLength.slice(0, -1);
      this.updateInputDisplay();
    } else if (/^[0-9.]$/.test(e.key)) {
      this.typedLength += e.key;
      this.updateInputDisplay();
      // Jika input box belum muncul (misal user mengetik tanpa klik pertama), munculkan di tengah atau dekat mouse
      if (!this.inputEl && this.points.length > 0) {
        // Fallback position logic could go here
      }
    }
  };

  // --- Logic Helpers ---
  private resetDrawingPlane() {
    this.syncGroundPlane();
    const camera = this.getCamera();
    if ((camera as any).isOrthographicCamera) {
      // For orthographic views (front/side/top), use a view-aligned plane so
      // ray/plane intersection stays stable and follows the cursor.
      const viewNormal = camera.getWorldDirection(this.tempVec3b).normalize();
      const groundY = -this.groundPlane.constant;
      this.tempVec3.set(0, groundY, 0);
      this.plane.setFromNormalAndCoplanarPoint(viewNormal, this.tempVec3);
    } else {
      this.plane.copy(this.groundPlane);
    }
    this.planeLocked = false;
  }

  private syncGroundPlane() {
    const groundRef =
      this.scene.getObjectByName("Grid") ?? this.scene.getObjectByName("AxesWorld");
    const groundY = groundRef ? groundRef.getWorldPosition(this.tempVec3).y : 0;
    this.groundPlane.normal.set(0, 1, 0);
    this.groundPlane.constant = -groundY;
  }

  private getMaxPickDistance() {
    const far = (this.getCamera() as any).far;
    return typeof far === "number" && isFinite(far) ? far : 1e6;
  }

  private getSurfacePlane(intersection: THREE.Intersection): THREE.Plane | undefined {
    const face = intersection.face;
    if (!face) return undefined;

    const normal = face.normal.clone();
    normal.transformDirection(intersection.object.matrixWorld).normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, intersection.point);
  }

  private pickPoint(e: PointerEvent): PickInfo | null {
    // If projection changes while the tool is active, keep the default plane
    // in sync (only before the first click).
    if (!this.planeLocked && this.points.length === 0) {
      this.resetDrawingPlane();
    }

    const rect = this.container.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const camera = this.getCamera();
    this.raycaster.setFromCamera(this.mouse, camera);
    const maxDist = this.getMaxPickDistance();

    const meshCandidates: THREE.Object3D[] = [];
    const lineCandidates: THREE.Object3D[] = [];
    this.scene.traverse((obj) => {
      if (obj.name === "SkyDome" || obj.name === "Grid" || (obj as any).userData.isHelper) return;
      if ((obj as any).isMesh) meshCandidates.push(obj);
      else if ((obj as any).isLine) lineCandidates.push(obj);
    });

    const meshHit = this.raycaster.intersectObjects(meshCandidates, true)[0];
    const lineHit = this.raycaster.intersectObjects(lineCandidates, true)[0];
    const surfaceHit: THREE.Intersection | null =
      (meshHit && meshHit.distance <= maxDist ? meshHit : null) ??
      (lineHit && lineHit.distance <= maxDist ? lineHit : null);

    let planePoint: THREE.Vector3 | null = null;
    if (this.raycaster.ray.intersectPlane(this.plane, this.tempVec3)) {
      const dist = this.raycaster.ray.origin.distanceTo(this.tempVec3);
      if (dist <= maxDist) planePoint = this.tempVec3.clone();
    }

    let viewPoint: THREE.Vector3 | null = null;
    const viewRef =
      this.points.length > 0 ? this.points[this.points.length - 1] : surfaceHit?.point ?? null;

    if (viewRef) {
      const viewNormal = camera.getWorldDirection(this.tempVec3b).normalize();
      const viewPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewNormal, viewRef);
      if (this.raycaster.ray.intersectPlane(viewPlane, this.tempVec3)) {
        const dist = this.raycaster.ray.origin.distanceTo(this.tempVec3);
        if (dist <= maxDist) viewPoint = this.tempVec3.clone();
      }
    }

    const starting = this.points.length === 0 && !this.planeLocked;
    let chosenPoint: THREE.Vector3 | null = null;
    let surfacePlane: THREE.Plane | undefined;

    if (starting) {
      if (surfaceHit) {
        chosenPoint = surfaceHit.point.clone();
        if (surfaceHit === meshHit) surfacePlane = this.getSurfacePlane(surfaceHit);
      } else {
        chosenPoint = planePoint ?? viewPoint;
      }
    } else {
      chosenPoint = planePoint ?? (surfaceHit ? surfaceHit.point.clone() : null) ?? viewPoint;
    }

    if (!chosenPoint) return null;
    return { point: chosenPoint, surfacePlane };
  }

  private createFaceFromLoop(loop: THREE.Vector3[]): THREE.Mesh | null {
    const points = loop.slice();
    if (points.length < 3) return null;

    const closeEps = 1e-5;
    if (points[0].distanceTo(points[points.length - 1]) < closeEps) points.pop();

    const cleaned: THREE.Vector3[] = [];
    for (const p of points) {
      const prev = cleaned[cleaned.length - 1];
      if (prev && prev.distanceTo(p) < closeEps) continue;
      cleaned.push(p.clone());
    }
    if (cleaned.length < 3) return null;

    const origin = cleaned[0];
    let normal: THREE.Vector3 | null = null;
    for (let i = 1; i < cleaned.length - 1 && !normal; i++) {
      const v1 = cleaned[i].clone().sub(origin);
      for (let j = i + 1; j < cleaned.length && !normal; j++) {
        const v2 = cleaned[j].clone().sub(origin);
        const n = v1.clone().cross(v2);
        if (n.lengthSq() > 1e-10) normal = n.normalize();
      }
    }
    if (!normal) return null;

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    const planarEps = 1e-3;
    if (!cleaned.every((p) => Math.abs(plane.distanceToPoint(p)) < planarEps)) return null;

    const helperAxis =
      Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(helperAxis, normal).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();

    const shape = new THREE.Shape();
    const p0 = cleaned[0].clone().sub(origin);
    shape.moveTo(p0.dot(u), p0.dot(v));
    for (let i = 1; i < cleaned.length; i++) {
      const p = cleaned[i].clone().sub(origin);
      shape.lineTo(p.dot(u), p.dot(v));
    }
    shape.closePath();

    const geometry = new THREE.ShapeGeometry(shape);
    const material = createPhongMaterial({
      color: 0xcccccc,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });

    const mesh = new THREE.Mesh(geometry, material);
    const basis = new THREE.Matrix4().makeBasis(u, v, normal).setPosition(origin);
    mesh.applyMatrix4(basis);
    mesh.userData.selectable = true; // Ensure explicitly selectable
    mesh.userData.entityType = "face";

    const edges = new THREE.EdgesGeometry(geometry);
    const outline = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x000000, depthWrite: false })
    );
    outline.userData.selectable = false;
    outline.userData.isFaceOutline = true;
    outline.renderOrder = 1;
    mesh.add(outline);
    (mesh.userData as any).__faceOutline = outline;

    return mesh;
  }

  private getMeshEdgesGeometry(geometry: THREE.BufferGeometry, thresholdAngle: number) {
    let byThreshold = this.meshEdgesCache.get(geometry);
    if (!byThreshold) {
      byThreshold = new Map();
      this.meshEdgesCache.set(geometry, byThreshold);
    }

    const cached = byThreshold.get(thresholdAngle);
    if (cached) return cached;

    const edges = new THREE.EdgesGeometry(geometry, thresholdAngle);
    byThreshold.set(thresholdAngle, edges);
    return edges;
  }

  private tryAutoCreateFaces(options?: {
    plane?: THREE.Plane;
    includeMeshEdges?: boolean;
    meshEdgeThresholdAngle?: number;
    extraPolyline?: THREE.Vector3[];
  }) {
    type Edge = { a: number; b: number };
    type PlaneInfo = { normal: THREE.Vector3; origin: THREE.Vector3 };

    const planeFilter = options?.plane;
    const includeMeshEdges = options?.includeMeshEdges ?? false;
    // meshEdgeThresholdAngle ignored here, we force 1 degree for strictness inside the loop if needed, or stick to passed value if we trust it.
    // But per user request "perfect", sticking to 1.

    const extraPolyline = options?.extraPolyline;

    // Ensure matrixWorld is up to date before sampling lines/meshes.
    this.scene.updateMatrixWorld(true);

    // Include:
    // - user-drawn lines (selectable === true)
    // - outlines of faces created by this tool (LineSegments child of a selectable face mesh)
    const isFaceOutline = (obj: THREE.Object3D) => {
      let current: THREE.Object3D | null = obj.parent;
      while (current && current !== this.scene) {
        if (current.userData?.selectable === true && current.userData?.entityType === "face") return true;
        current = current.parent;
      }
      return false;
    };

    const lineSources: THREE.Line[] = [];
    this.scene.traverse((obj) => {
      if ((obj as any).userData?.isHelper) return;
      if (obj.name === "SkyDome" || obj.name === "Grid" || obj.name === "AxesWorld") return;
      if (!(obj as any).isLine) return;

      if (obj.userData?.selectable === true) {
        lineSources.push(obj as THREE.Line);
        return;
      }

      if (isFaceOutline(obj)) {
        lineSources.push(obj as THREE.Line);
      }
    });

    if (lineSources.length === 0 && (!extraPolyline || extraPolyline.length < 2)) return;

    // Re-sync createdFaceHashes with the scene to allow re-creation of deleted faces
    this.createdFaceHashes.clear();
    this.scene.traverse((obj) => {
      if (obj.userData?.entityType === "face" && obj.userData?.loopHash) {
        this.createdFaceHashes.add(obj.userData.loopHash);
      }
    });

    const planeDistEps = 1e-3;
    const keyEps = 1e-3;
    const quant = (n: number) => Math.round(n / keyEps);
    const keyOf = (v: THREE.Vector3) => `${quant(v.x)},${quant(v.y)},${quant(v.z)}`;

    const vertices: THREE.Vector3[] = [];
    const keys: string[] = [];
    const keyToIndex = new Map<string, number>();
    const adjacency: number[][] = [];
    const edges: Edge[] = [];
    const edgeSet = new Set<string>();
    const userEdgeSet = new Set<string>();

    const getIndex = (p: THREE.Vector3) => {
      const k = keyOf(p);
      const existing = keyToIndex.get(k);
      if (existing !== undefined) return existing;
      const index = vertices.length;
      keyToIndex.set(k, index);
      vertices.push(p.clone());
      keys.push(k);
      adjacency[index] = [];
      return index;
    };

    const addEdge = (a: number, b: number, markUser: boolean) => {
      if (a === b) return;
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      const edgeKey = `${min}|${max}`;
      if (markUser) userEdgeSet.add(edgeKey);
      if (edgeSet.has(edgeKey)) return;
      edgeSet.add(edgeKey);
      edges.push({ a: min, b: max });
      adjacency[a].push(b);
      adjacency[b].push(a);
    };

    const includeSegment = (
      aWorld: THREE.Vector3,
      bWorld: THREE.Vector3,
      source: "user" | "mesh"
    ) => {
      if (planeFilter) {
        if (Math.abs(planeFilter.distanceToPoint(aWorld)) >= planeDistEps) return;
        if (Math.abs(planeFilter.distanceToPoint(bWorld)) >= planeDistEps) return;
      }

      addEdge(getIndex(aWorld), getIndex(bWorld), source === "user");
    };

    // --- NEW: Multi-pass Splitting Logic ---

    // 1. Collect all potential "Splitter" points.
    // These are endpoints of user lines, face outlines, and the current drawing polyline.
    const splitters: THREE.Vector3[] = [];
    // We can filter mostly by key to avoid duplicate processing, but need Vector3 for distance checks.
    const splitterKeys = new Set<string>();

    const addSplitter = (v: THREE.Vector3) => {
      const k = keyOf(v);
      if (!splitterKeys.has(k)) {
        splitterKeys.add(k);
        splitters.push(v);
      }
    };

    // From extraPolyline
    if (extraPolyline) {
      extraPolyline.forEach(p => addSplitter(p));
    }

    // From lineSources
    for (const line of lineSources) {
      const geom = line.geometry;
      if (!(geom instanceof THREE.BufferGeometry)) continue;
      const pos = geom.getAttribute("position");
      if (!pos) continue;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(line.matrixWorld);
        addSplitter(v);
      }
    }

    // Helper: Add segment A-B but split it by any collinear points in 'splitters'
    const addSegmentWithSplits = (a: THREE.Vector3, b: THREE.Vector3, source: "user" | "mesh") => {
      let start = a;
      let end = b;

      // Snap endpoints to existing splitters to ensure connectivity
      for (const v of splitters) {
        if (start !== v && start.distanceTo(v) < 1e-4) start = v;
        if (end !== v && end.distanceTo(v) < 1e-4) end = v;
      }

      const splitPoints: { pt: THREE.Vector3, dist: number }[] = [];
      const dAB = start.distanceTo(end);

      // Optimization: bounding box check?
      // For now, simple iteration. splitters.length is usually small (<1000).
      for (const v of splitters) {
        if (v === start || v === end) continue;

        const dAP = start.distanceTo(v);
        const dPB = v.distanceTo(end);

        // Use a tighter tolerance for collinearity
        if (Math.abs(dAP + dPB - dAB) < 1e-4) {
          splitPoints.push({ pt: v, dist: dAP });
        }
      }

      if (splitPoints.length === 0) {
        includeSegment(start, end, source);
        return;
      }

      splitPoints.sort((x, y) => x.dist - y.dist);
      let curr = start;
      for (const sp of splitPoints) {
        includeSegment(curr, sp.pt, source);
        curr = sp.pt;
      }
      includeSegment(curr, end, source);
    };

    // 2. Process Line Sources (User Lines & Face Outlines)
    for (const line of lineSources) {
      const geom = line.geometry;
      const pos = geom.getAttribute("position");
      if (!pos) continue;

      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < pos.count; i++) {
        pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(line.matrixWorld));
      }

      const isSegs = (line as any).isLineSegments === true;
      if (isSegs) {
        for (let i = 0; i < pts.length - 1; i += 2) {
          addSegmentWithSplits(pts[i], pts[i + 1], "user");
        }
      } else {
        for (let i = 0; i < pts.length - 1; i++) {
          addSegmentWithSplits(pts[i], pts[i + 1], "user");
        }
      }
    }

    // 3. Process Extra Polyline (Current drawing)
    if (extraPolyline && extraPolyline.length >= 2) {
      for (let i = 0; i < extraPolyline.length - 1; i++) {
        addSegmentWithSplits(extraPolyline[i], extraPolyline[i + 1], "user");
      }
    }

    // 4. Process Mesh Edges
    const supersededMeshes = new Set<THREE.Mesh>();

    if (includeMeshEdges && splitters.length > 0) {
      // Calculate Bounds of the "Hot Area" (Splitters)
      const splitterBox = new THREE.Box3();
      for (const s of splitters) splitterBox.expandByPoint(s);
      // Expand slightly to catch collinear edges
      splitterBox.expandByScalar(0.01);

      // Seed keys for mesh edges: must touch the known graph (splitters)
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();

      this.scene.traverse((obj) => {
        if ((obj as any).userData?.isHelper) return;
        if (obj.name === "SkyDome" || obj.name === "Grid" || obj.name === "AxesWorld" || (obj as any).isGridHelper) return;
        if (!(obj as any).isMesh) return;

        // Check for Supersession (Coplanar + Intersects Bounds)
        // If superseded, we MUST absorb ALL edges to rebuild the face.
        let isSuperseded = false;
        const mesh = obj as THREE.Mesh;
        if (mesh.userData?.entityType === "face") return; // outlines handled via lineSources

        // Coplanar Check
        // Ideally we check if mesh is on the current plane filter if present
        if (planeFilter) {
          const pos = new THREE.Vector3();
          mesh.getWorldPosition(pos);
          if (Math.abs(planeFilter.distanceToPoint(pos)) < 1e-2) {
            // Normal Check
            const q = new THREE.Quaternion();
            mesh.getWorldQuaternion(q);
            const norm = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
            if (Math.abs(norm.dot(planeFilter.normal)) > 0.9) {
              // Bounds Check
              if (mesh.geometry.boundingBox) {
                // box is local, transform to world?
                // Simple center check is faster but inaccurate.
                // Let's use Box3 setFromObject
                const box = new THREE.Box3().setFromObject(mesh);
                if (splitterBox.intersectsBox(box)) {
                  isSuperseded = true;
                }
              }
            }
          }
        }

        if (isSuperseded) {
          supersededMeshes.add(mesh);
        }

        const geom = mesh.geometry;
        if (!(geom instanceof THREE.BufferGeometry)) return;
        if (!geom.getAttribute("position")) return;

        const edgesGeom = this.getMeshEdgesGeometry(geom, 1); // 1 degree threshold
        const pos = edgesGeom.getAttribute("position") as THREE.BufferAttribute | undefined;
        if (!pos) return;

        for (let i = 0; i < pos.count - 1; i += 2) {
          a.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
          b.set(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).applyMatrix4(mesh.matrixWorld);

          // If mesh is superseded, we absorb EVERYTHING.
          // Otherwise, we only absorb "relevant" edges (touching splitters).
          let relevant = isSuperseded;
          if (!relevant) {
            if (splitterKeys.has(keyOf(a)) || splitterKeys.has(keyOf(b))) {
              relevant = true;
            } else {
              const dAB = a.distanceTo(b);
              for (const v of splitters) {
                const dAP = a.distanceTo(v);
                const dPB = v.distanceTo(b);
                if (Math.abs(dAP + dPB - dAB) < 1e-4) {
                  relevant = true;
                  break;
                }
              }
            }
          }

          if (relevant) {
            addSegmentWithSplits(a, b, "mesh");
          }
        }
      });
    }

    if (edges.length === 0) return;

    // ... Plane and Cycle detection ...

    // Candidate planes from pairs of incident edges (allows planar faces even when the whole graph is non-planar).
    const canonicalizeNormal = (n: THREE.Vector3) => {
      const ax = Math.abs(n.x);
      const ay = Math.abs(n.y);
      const az = Math.abs(n.z);

      if (ay >= ax && ay >= az) {
        if (n.y < 0) n.multiplyScalar(-1);
      } else if (ax >= ay && ax >= az) {
        if (n.x < 0) n.multiplyScalar(-1);
      } else {
        if (n.z < 0) n.multiplyScalar(-1);
      }
      return n;
    };

    const normalEps = 1e-3;
    const planeConstEps = 1e-3;
    const qn = (v: number) => Math.round(v / normalEps);
    const qc = (v: number) => Math.round(v / planeConstEps);

    const planeCandidates = new Map<string, PlaneInfo>();
    if (planeFilter) {
      const origin = new THREE.Vector3();
      planeFilter.coplanarPoint(origin);

      const n = planeFilter.normal.clone().normalize();
      canonicalizeNormal(n);

      const c = n.dot(origin);
      const key = `${qn(n.x)},${qn(n.y)},${qn(n.z)}|${qc(c)}`;
      planeCandidates.set(key, { normal: n, origin });
    } else {
      for (let i = 0; i < vertices.length; i++) {
        const neigh = adjacency[i];
        if (!neigh || neigh.length < 2) continue;
        const origin = vertices[i];

        for (let a = 0; a < neigh.length - 1; a++) {
          for (let b = a + 1; b < neigh.length; b++) {
            const d1 = vertices[neigh[a]].clone().sub(origin);
            const d2 = vertices[neigh[b]].clone().sub(origin);
            const n = d1.cross(d2);
            if (n.lengthSq() < 1e-10) continue;
            n.normalize();
            canonicalizeNormal(n);

            const c = n.dot(origin);
            const key = `${qn(n.x)},${qn(n.y)},${qn(n.z)}|${qc(c)}`;
            if (!planeCandidates.has(key)) {
              planeCandidates.set(key, { normal: n.clone(), origin: origin.clone() });
            }
          }
        }
      }
    }

    if (planeCandidates.size === 0) return;

    const areaEps = 1e-7;
    const maxWalkSteps = 10000;



    const loopHasUserEdge = (loop: number[]) => {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        if (userEdgeSet.has(`${min}|${max}`)) return true;
      }
      return false;
    };

    for (const { normal, origin } of planeCandidates.values()) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);

      const helperAxis =
        Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(helperAxis, normal).normalize();
      const v = new THREE.Vector3().crossVectors(normal, u).normalize();

      const coords = new Map<number, { x: number; y: number }>();
      for (let i = 0; i < vertices.length; i++) {
        if (Math.abs(plane.distanceToPoint(vertices[i])) >= planeDistEps) continue;
        const rel = vertices[i].clone().sub(origin);
        coords.set(i, { x: rel.dot(u), y: rel.dot(v) });
      }

      if (coords.size < 3) continue;

      const planeAdj = new Map<number, number[]>();
      for (const e of edges) {
        if (!coords.has(e.a) || !coords.has(e.b)) continue;
        (planeAdj.get(e.a) ?? planeAdj.set(e.a, []).get(e.a)!).push(e.b);
        (planeAdj.get(e.b) ?? planeAdj.set(e.b, []).get(e.b)!).push(e.a);
      }

      if (planeAdj.size < 3) continue;

      const neighborOrder = new Map<number, number[]>();
      const neighborIndex = new Map<string, number>();

      for (const [from, neighs] of planeAdj) {
        const fromCoord = coords.get(from);
        if (!fromCoord) continue;

        const uniqueNeighs = Array.from(new Set(neighs));
        uniqueNeighs.sort((a, b) => {
          const aCoord = coords.get(a);
          const bCoord = coords.get(b);
          if (!aCoord || !bCoord) return 0;
          const aAng = Math.atan2(aCoord.y - fromCoord.y, aCoord.x - fromCoord.x);
          const bAng = Math.atan2(bCoord.y - fromCoord.y, bCoord.x - fromCoord.x);
          return aAng - bAng;
        });

        neighborOrder.set(from, uniqueNeighs);
        uniqueNeighs.forEach((to, idx) => neighborIndex.set(`${from}|${to}`, idx));
      }

      const visitedDir = new Set<string>();
      // Collect all valid loops first
      type LoopData = {
        indices: number[];
        polygon: { x: number; y: number }[];
        area: number;
        hash: string;
      };

      const loopsFound: LoopData[] = [];

      for (const [startFrom, starts] of neighborOrder) {
        for (const startTo of starts) {
          const startKey = `${startFrom}->${startTo}`;
          if (visitedDir.has(startKey)) continue;

          const loopIndices: number[] = [];
          let from = startFrom;
          let to = startTo;
          let steps = 0;

          while (steps++ < maxWalkSteps) {
            visitedDir.add(`${from}->${to}`);
            loopIndices.push(from);

            const toNeigh = neighborOrder.get(to);
            if (!toNeigh || toNeigh.length === 0) {
              loopIndices.length = 0;
              break;
            }

            const idx = neighborIndex.get(`${to}|${from}`);
            if (idx === undefined) {
              loopIndices.length = 0;
              break;
            }

            const next = toNeigh[(idx + 1) % toNeigh.length];
            from = to;
            to = next;

            if (from === startFrom && to === startTo) break;
          }

          if (loopIndices.length < 3) continue;
          if (!(from === startFrom && to === startTo)) continue;

          // Check if loop has at least one user edge
          if (!loopHasUserEdge(loopIndices)) continue;

          const poly: { x: number; y: number }[] = [];
          for (const idx of loopIndices) {
            const c = coords.get(idx);
            if (c) poly.push(c);
          }
          if (poly.length < 3) continue;

          // Compute signed area
          let area = 0;
          for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            area += a.x * b.y - a.y * b.x;
          }
          area *= 0.5;

          if (Math.abs(area) <= areaEps) continue;

          // Ensure CCW winding for outer shapes (Three.js Shapes usually CCW)
          // If area is negative, reverse
          if (area < 0) {
            loopIndices.reverse();
            poly.reverse();
            area = -area;
          }

          const hash = loopIndices.map((idx) => keys[idx]).sort().join("|");

          loopsFound.push({
            indices: loopIndices,
            polygon: poly,
            area,
            hash
          });
        }
      }

      // Hierarchy Processing for Holes
      // 1. Sort by Area Descending
      loopsFound.sort((a, b) => b.area - a.area);

      type HierarchyNode = {
        data: LoopData;
        children: HierarchyNode[];
      };

      const roots: HierarchyNode[] = [];

      const isPointInsidePoly = (p: { x: number, y: number }, poly: { x: number, y: number }[]) => {
        // Ray casting
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].x, yi = poly[i].y;
          const xj = poly[j].x, yj = poly[j].y;
          const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
          if (intersect) inside = !inside;
        }
        return inside;
      };

      const isPolyComputedInside = (inner: { x: number, y: number }[], outer: { x: number, y: number }[]) => {
        // Check first point (sufficient for non-intersecting valid geometry)
        return isPointInsidePoly(inner[0], outer);
      };

      for (const loop of loopsFound) {
        // Find parent
        // Because sorted by area, parent must be already processed (in roots or its descendants)
        // We find the smallest node that contains this loop.

        const findParent = (nodes: HierarchyNode[]): HierarchyNode | null => {
          for (const node of nodes) {
            if (isPolyComputedInside(loop.polygon, node.data.polygon)) {
              const childMatch = findParent(node.children);
              return childMatch ?? node;
            }
          }
          return null;
        };

        const parent = findParent(roots);
        if (parent) {
          parent.children.push({ data: loop, children: [] });
        } else {
          roots.push({ data: loop, children: [] });
        }
      }

      // Build Shapes from Hierarchy
      // Level 0 (Roots) = Solid
      // Level 1 (Children of Roots) = Holes
      // Level 2 (Children of Level 1) = Solid (Islands)...

      const shapesToCreate: { outer: LoopData, holes: LoopData[] }[] = [];

      const processNode = (node: HierarchyNode) => {
        // Create a face for this node
        // Children are Holes in this face
        const holes = node.children.map(c => c.data);
        shapesToCreate.push({ outer: node.data, holes });

        // Recursively process children to create their Own faces (Islands)
        for (const child of node.children) {
          processNode(child);
        }
      };

      for (const root of roots) {
        processNode(root);
      }

      const validHashesForPlane = new Set<string>();

      // Create Meshes
      for (const item of shapesToCreate) {
        // Construct composite hash (Outer + Holes) because topology changed
        // Sorting hashes ensures stability regardless of hole order
        const compositeHash = [item.outer.hash, ...item.holes.map(h => h.hash)].sort().join("||");

        validHashesForPlane.add(compositeHash);

        if (this.createdFaceHashes.has(compositeHash)) continue;

        // Build THREE.Shape
        const shape = new THREE.Shape();
        const outerPts = item.outer.polygon;
        shape.moveTo(outerPts[0].x, outerPts[0].y);
        for (let i = 1; i < outerPts.length; i++) shape.lineTo(outerPts[i].x, outerPts[i].y);
        shape.closePath();

        for (const holeLoop of item.holes) {
          const holePath = new THREE.Path();
          const holePts = holeLoop.polygon;
          // Holes should be CW? shape.holes docs say it auto-detects or needs opposite winding.
          // Using standard helper might be safer, but manual path is fine.
          holePath.moveTo(holePts[0].x, holePts[0].y);
          for (let i = 1; i < holePts.length; i++) holePath.lineTo(holePts[i].x, holePts[i].y);
          holePath.closePath();
          shape.holes.push(holePath);
        }

        const geometry = new THREE.ShapeGeometry(shape);
        const material = createPhongMaterial({
          color: 0xcccccc,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });

        const mesh = new THREE.Mesh(geometry, material);
        // Align mesh to place
        const basis = new THREE.Matrix4().makeBasis(u, v, normal).setPosition(origin);
        mesh.applyMatrix4(basis);

        mesh.userData.selectable = true;
        mesh.userData.entityType = "face";
        mesh.userData.loopHash = compositeHash;

        // Add outline
        const edges = new THREE.EdgesGeometry(geometry);
        const outline = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({ color: 0x000000, depthWrite: false })
        );
        outline.userData.selectable = false;
        outline.userData.isFaceOutline = true;
        outline.renderOrder = 1;
        mesh.add(outline);
        (mesh.userData as any).__faceOutline = outline;

        this.scene.add(mesh);
        this.createdFaceHashes.add(compositeHash);
      }

      // Cleanup Pass: Remove faces on this plane that are no longer valid
      const facesToRemove: THREE.Object3D[] = [];
      this.scene.traverse((obj) => {
        if (obj.userData?.entityType !== "face") return;
        if (!obj.userData?.loopHash) return;

        // Check if on this plane
        if ((obj as any).isMesh) {
          const pos = new THREE.Vector3();
          obj.getWorldPosition(pos);
          if (Math.abs(plane.distanceToPoint(pos)) > 1e-3) return;

          const q = new THREE.Quaternion();
          obj.getWorldQuaternion(q);
          const objNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
          if (Math.abs(objNormal.dot(plane.normal)) < 0.9) return;

          if (!validHashesForPlane.has(obj.userData.loopHash)) {
            facesToRemove.push(obj);
          }
        }
      });

      for (const face of facesToRemove) {
        this.scene.remove(face);
        if ((face as any).geometry) (face as any).geometry.dispose();
        this.createdFaceHashes.delete(face.userData.loopHash);
      }

      // Cleanup Superseded Meshes (Foreign faces that we fully rebuilt)
      for (const mesh of supersededMeshes) {
        this.scene.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.userData.loopHash) {
          this.createdFaceHashes.delete(mesh.userData.loopHash);
        }
      }
    }
  }

  private finalizeLine() {
    if (this.points.length < 2) {
      this.points = [];
      this.typedLength = "";
      this.edgeLockDirs = [];
      this.cleanupVisuals();
      this.removeInputOverlay();
      this.hideAxisInfo();
      this.resetDrawingPlane();
      return;
    }

    const isClosed =
      this.points.length > 3 &&
      this.points[0].distanceTo(this.points[this.points.length - 1]) < 1e-5;

    const computeLoopHash = (points: THREE.Vector3[]) => {
      const closeEps = 1e-5;
      const pts = points.slice();
      if (pts[0].distanceTo(pts[pts.length - 1]) < closeEps) pts.pop();

      const cleaned: THREE.Vector3[] = [];
      for (const p of pts) {
        const prev = cleaned[cleaned.length - 1];
        if (prev && prev.distanceTo(p) < closeEps) continue;
        cleaned.push(p.clone());
      }

      const keyEps = 1e-3;
      const quant = (n: number) => Math.round(n / keyEps);
      const keyOf = (v: THREE.Vector3) => `${quant(v.x)},${quant(v.y)},${quant(v.z)}`;
      return cleaned.map(keyOf).sort().join("|");
    };

    const loopHash = isClosed ? computeLoopHash(this.points) : "";
    const faceAlreadyExists = !!loopHash && this.createdFaceHashes.has(loopHash);
    let object: THREE.Object3D;

    if (isClosed && !faceAlreadyExists) {
      const mesh = this.createFaceFromLoop(this.points);
      if (mesh) {
        object = mesh;
      } else {
        const geometry = new THREE.BufferGeometry().setFromPoints(this.points);
        const material = new THREE.LineBasicMaterial({ color: 0x000000, depthWrite: false });
        object = new THREE.Line(geometry, material);
      }
    } else {
      const geometry = new THREE.BufferGeometry().setFromPoints(this.points);
      const material = new THREE.LineBasicMaterial({ color: 0x000000, depthWrite: false });
      object = new THREE.Line(geometry, material);
    }

    if ((object as any).isMesh) {
      if (loopHash) {
        object.userData.loopHash = loopHash;
        this.createdFaceHashes.add(loopHash);
      }
    }

    if ((object as THREE.Line).isLine) {
      object.renderOrder = 2;
    }

    object.userData.selectable = true;
    object.userData.entityType = (object as any).isMesh ? "face" : "line";
    this.scene.add(object);
    try {
      this.onLineCreated?.(object);
    } catch (error) {
      console.error("LineTool onLineCreated callback failed:", error);
    }

    try {
      if (this.points.length >= 2) {
        this.tryAutoCreateFaces({ includeMeshEdges: true });
      }
    } catch (e) {
      console.error("Auto face creation failed:", e);
    }

    this.points = [];
    this.typedLength = "";
    this.edgeLockDirs = [];
    this.cleanupVisuals();
    this.removeInputOverlay();
    this.hideAxisInfo();
    this.resetDrawingPlane();
  }

  // --- Visual Updaters ---

  private updateConnectorDot(pos: THREE.Vector3, snapKind?: SnapKind) {
    if (!this.connectorDot) {
      const canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.beginPath(); ctx.arc(32, 32, 16, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = "#000"; ctx.stroke();

      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false });
      this.connectorDot = new THREE.Sprite(mat);
      this.connectorDot.scale.set(0.5, 0.5, 1);
      this.connectorDot.renderOrder = 999;
      this.connectorDot.userData.isHelper = true;
      this.scene.add(this.connectorDot);
    }
    this.connectorDot.position.copy(pos);

    const mat = this.connectorDot.material;
    if (snapKind === "endpoint") mat.color.setHex(0x00ff00);
    else if (snapKind === "midpoint") mat.color.setHex(0x00ffff);
    else mat.color.setHex(0xffffff);
  }

  private updatePreviewLine(currentPos: THREE.Vector3) {
    if (this.points.length === 0) return;

    const pts = [...this.points, currentPos];
    const geometry = new THREE.BufferGeometry().setFromPoints(pts);

    if (!this.previewLine) {
      const material = new THREE.LineBasicMaterial({
        color: this.previewColor,
        depthTest: false,
        depthWrite: false,
      });
      this.previewLine = new THREE.Line(geometry, material);
      this.previewLine.userData.isHelper = true;
      this.previewLine.renderOrder = 997;
      this.scene.add(this.previewLine);
    } else {
      this.previewLine.geometry.dispose();
      this.previewLine.geometry = geometry;
    }
  }

  private updateAxisGuides(lines: { axis: "x" | "y" | "z", origin: THREE.Vector3 }[]) {
    // Hide extra existing guides
    for (let i = lines.length; i < this.axisGuides.length; i++) {
      if (this.axisGuides[i]) this.axisGuides[i].visible = false;
    }

    // Create/Update needed guides
    for (let i = 0; i < lines.length; i++) {
      let guide = this.axisGuides[i];
      if (!guide) {
        const geom = new THREE.BufferGeometry();
        const mat = new THREE.LineDashedMaterial({
          color: 0xff0000,
          dashSize: 0.5,
          gapSize: 0.3,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1
        });
        guide = new THREE.Line(geom, mat);
        guide.userData.isHelper = true;
        guide.renderOrder = 998;
        this.scene.add(guide);
        this.axisGuides[i] = guide;
      } else if (!guide.parent) {
        this.scene.add(guide);
      }

      const { axis, origin } = lines[i];
      const mat = guide.material as THREE.LineDashedMaterial;
      mat.color.setHex(axis === 'x' ? 0xff0000 : axis === 'y' ? 0x00ff00 : 0x0000ff);

      const dir = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const p1 = origin.clone().addScaledVector(dir, -1000);
      const p2 = origin.clone().addScaledVector(dir, 1000);

      guide.geometry.setFromPoints([p1, p2]);
      guide.computeLineDistances();
      guide.visible = true;
    }
  }

  // (Original updateAxisGuide removed/commented out)

  private getEdgeLockDirsFromSnap(snap: SnapResult | null, target: THREE.Vector3) {
    if (!snap) return [];
    if (snap.kind !== "endpoint" && snap.kind !== "midpoint") return [];
    if (snap.point.distanceTo(target) > this.SNAP_THRESHOLD) return [];

    const edges = snap.edges ?? (snap.edge ? [snap.edge] : []);
    if (edges.length === 0) return [];

    const planeNormal = this.plane.normal;
    const dirs: THREE.Vector3[] = [];
    const unfiltered: THREE.Vector3[] = [];
    const dirEps = 0.999;

    for (const edge of edges) {
      const dir = edge.b.clone().sub(edge.a);
      if (dir.lengthSq() < 1e-12) continue;
      dir.normalize();

      if (!unfiltered.some((d) => Math.abs(d.dot(dir)) > dirEps)) unfiltered.push(dir);

      // Prefer directions that lie on the current drawing plane.
      if (Math.abs(dir.dot(planeNormal)) > 0.15) continue;
      if (!dirs.some((d) => Math.abs(d.dot(dir)) > dirEps)) dirs.push(dir);
    }

    return dirs.length > 0 ? dirs : unfiltered;
  }

  private updateSnapGuides(snap: SnapResult | null) {
    const shouldShow =
      !!snap &&
      (snap.kind === "endpoint" || snap.kind === "midpoint") &&
      (snap.edges?.length || snap.edge);

    if (!shouldShow) {
      if (this.snapGuides) this.snapGuides.visible = false;
      return;
    }

    const dirs = this.getEdgeLockDirsFromSnap(snap, snap.point);
    if (dirs.length === 0) {
      if (this.snapGuides) this.snapGuides.visible = false;
      return;
    }

    if (!this.snapGuides) {
      this.snapGuides = new THREE.Group();
      this.snapGuides.userData.isHelper = true;
      this.scene.add(this.snapGuides);
    }

    const length = 1000;
    const ensureLine = (index: number) => {
      if (this.snapGuideLines[index]) return this.snapGuideLines[index];

      const geom = new THREE.BufferGeometry();
      const mat = new THREE.LineDashedMaterial({
        color: 0xff00ff,
        dashSize: 0.5,
        gapSize: 0.3,
        depthTest: false,
        depthWrite: false,
      });
      const line = new THREE.Line(geom, mat);
      line.userData.isHelper = true;
      line.renderOrder = 998;
      this.snapGuides!.add(line);
      this.snapGuideLines[index] = line;
      return line;
    };

    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      const line = ensureLine(i);
      const p1 = snap.point.clone().addScaledVector(dir, -length);
      const p2 = snap.point.clone().addScaledVector(dir, length);
      line.geometry.setFromPoints([p1, p2]);
      line.computeLineDistances();
      line.visible = true;
    }

    for (let i = dirs.length; i < this.snapGuideLines.length; i++) {
      this.snapGuideLines[i].visible = false;
    }

    this.snapGuides.visible = true;
  }

  private updateEdgeGuide(dir: THREE.Vector3 | null, origin?: THREE.Vector3) {
    if (!dir || !origin) {
      if (this.edgeGuide) this.edgeGuide.visible = false;
      return;
    }

    if (!this.edgeGuide) {
      const geom = new THREE.BufferGeometry();
      const mat = new THREE.LineDashedMaterial({
        color: 0xff00ff,
        dashSize: 0.5,
        gapSize: 0.3,
        depthTest: false,
        depthWrite: false,
      });
      this.edgeGuide = new THREE.Line(geom, mat);
      this.edgeGuide.userData.isHelper = true;
      this.edgeGuide.renderOrder = 998;
      this.scene.add(this.edgeGuide);
    }

    const length = 1000;
    const p1 = origin.clone().addScaledVector(dir, -length);
    const p2 = origin.clone().addScaledVector(dir, length);
    this.edgeGuide.geometry.setFromPoints([p1, p2]);
    this.edgeGuide.computeLineDistances();
    this.edgeGuide.visible = true;
  }



  // --- UI Overlays ---

  private showInputOverlay(x: number, y: number) {
    if (!this.inputEl) {
      this.inputEl = document.createElement("input");
      this.inputEl.type = "text";
      this.inputEl.placeholder = "Length...";
      this.inputEl.className = "control-panel"; // Reuse style
      Object.assign(this.inputEl.style, {
        position: "fixed",
        zIndex: "10000",
        width: "100px",
        padding: "4px 8px",
        fontSize: "12px",
        pointerEvents: "none", // Let user type but not click? Or focus it?
        // Actually for SketchUp style, you just type. We display what is typed.
        background: "rgba(255, 255, 255, 0.9)",
        color: "black",
        border: "1px solid #ccc",
        borderRadius: "4px"
      });
      document.body.appendChild(this.inputEl);
    }
    this.inputEl.style.left = `${x + 15}px`;
    this.inputEl.style.top = `${y + 15}px`;
    this.updateInputDisplay();
  }

  private updateInputDisplay() {
    if (this.inputEl) {
      this.inputEl.value = this.typedLength;
      this.inputEl.style.display = this.points.length > 0 ? "block" : "none";
    }
  }

  private removeInputOverlay() {
    if (this.inputEl) {
      this.inputEl.remove();
      this.inputEl = null;
    }
  }

  private updateAxisInfo(last: THREE.Vector3, curr: THREE.Vector3, axis: string | null) {
    if (!this.axisInfoEl) {
      this.axisInfoEl = document.createElement("div");
      Object.assign(this.axisInfoEl.style, {
        position: "fixed",
        zIndex: "9999",
        padding: "4px 8px",
        fontSize: "11px",
        borderRadius: "4px",
        background: "rgba(0,0,0,0.7)",
        color: "#fff",
        pointerEvents: "none",
        whiteSpace: "pre",
      });
      document.body.appendChild(this.axisInfoEl);
    }

    const dist = last.distanceTo(curr);
    const axisLabel = axis ?? "Free"; // Use passed label directly or fallback
    this.axisInfoEl.innerText = `Len: ${dist.toFixed(2)}m\n${axisLabel}`;

    // Position near mouse
    const rect = this.container.getBoundingClientRect();
    const pScreen = curr.clone().project(this.getCamera());
    const x = (pScreen.x * 0.5 + 0.5) * rect.width + rect.left;
    const y = (-pScreen.y * 0.5 + 0.5) * rect.height + rect.top;

    this.axisInfoEl.style.left = `${x + 20}px`;
    this.axisInfoEl.style.top = `${y + 20}px`;
    this.axisInfoEl.style.display = "block";
  }

  private hideAxisInfo() {
    if (this.axisInfoEl) this.axisInfoEl.style.display = "none";
  }
}

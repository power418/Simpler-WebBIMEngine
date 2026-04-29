import * as THREE from "three";
import { splitFloorsWithNewRect } from "../../helpers/polygon-clipper";
import { IntersectionHelper } from "../../helpers/intersection-helper";
import { IntersectionGuide } from "../../helpers/intersection-guide";
import { SnappingHelper } from "../../helpers/snapping-helper";
import { createPhongMaterial } from "../../utils/materials";
// import { type FaceData } from "../../helpers/face-detector";

const SURFACE_OFFSET = 0.001;
const OUTLINE_OFFSET = 0.0005; // Removed in favor of polygonOffset

function makeMaterial(color = 0xffffff) {
	return createPhongMaterial({
		color,
		transparent: false,
		opacity: 1.0,
		side: THREE.DoubleSide,
	});
}

function makeEdgeMaterial(color = 0x000000) {
	return new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false });
}

export class RectangleTool {
	private scene: THREE.Scene;
	private getCamera: () => THREE.Camera;
	private container: HTMLElement;

	private enabled = false;
	private isDrawing = false;
	private anchor: THREE.Vector3 | null = null;
	private previewMesh: THREE.Mesh | null = null;
	private previewEdge: THREE.LineLoop | null = null;
	private dimOverlay: HTMLInputElement | null = null;

	private mouse = new THREE.Vector2();
	private raycaster = new THREE.Raycaster();
	private planeXZ = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	private tempVec3 = new THREE.Vector3();

	// Helpers
	private intersectionHelper: IntersectionHelper;
	private intersectionGuide: IntersectionGuide;
	private snappingHelper: SnappingHelper;
	private connectorDot: THREE.Sprite | null = null; // Replaced snapMarker
	private setCameraZoom?: (enabled: boolean) => void;

	// Face-based drawing
	// private currentDrawingFace: FaceData | null = null;
	// private drawingPlane: THREE.Plane | null = null;

	constructor(
		scene: THREE.Scene,
		camera: THREE.Camera | (() => THREE.Camera),
		container: HTMLElement,
		options?: { setCameraZoom?: (enabled: boolean) => void }
	) {
		this.scene = scene;
		this.getCamera = typeof camera === "function" ? camera : () => camera;
		this.container = container;
		this.setCameraZoom = options?.setCameraZoom;

		this.intersectionHelper = new IntersectionHelper(this.getCamera, container);
		this.intersectionGuide = new IntersectionGuide(scene);
		this.snappingHelper = new SnappingHelper(scene, this.getCamera, container, this.raycaster);

		// Note: connectorDot is initialized lazily or in updateConnectorDot
	}

	public enable() {
		if (this.enabled) return;
		this.enabled = true;
		this.container.style.cursor = "crosshair";

		// Disable camera zoom when tool is active
		if (this.setCameraZoom) {
			this.setCameraZoom(false);
		}

		this.container.addEventListener("pointermove", this.onPointerMove);
		this.container.addEventListener("pointerdown", this.onPointerDown);
		window.addEventListener("keydown", this.onKeyDown);
	}

	public disable() {
		if (!this.enabled) return;
		this.enabled = false;
		this.container.style.cursor = "default";

		// Re-enable camera zoom when tool is disabled
		if (this.setCameraZoom) {
			this.setCameraZoom(true);
		}

		this.container.removeEventListener("pointermove", this.onPointerMove);
		this.container.removeEventListener("pointerdown", this.onPointerDown);
		window.removeEventListener("keydown", this.onKeyDown);

		this.cleanup();
	}

	private onPointerDown = (event: PointerEvent) => {
		// Allow right-click and middle-click to pass through for camera controls
		if (!this.enabled || event.button !== 0) return;

		const snapResult = this.getSnappedPoint(event);
		const hit = snapResult ? snapResult.point : null;

		if (!hit) return;

		// Only block left-click events for the tool
		event.preventDefault();
		event.stopPropagation();

		if (!this.isDrawing) {
			this.isDrawing = true;
			this.anchor = hit.clone();
			this.showDimInput(event.clientX, event.clientY);
			return;
		}

		this.finalize();
	};

	private onPointerMove = (event: PointerEvent) => {
		if (!this.enabled) return;

		// Allow camera controls: skip processing if right/middle buttons are pressed
		// event.buttons: 1=left, 2=right, 4=middle
		if (event.buttons === 2 || event.buttons === 4 || event.buttons === 6) return;

		const snapResult = this.getSnappedPoint(event);
		const hit = snapResult ? snapResult.point : null;

		if (!hit) {
			if (this.connectorDot) this.connectorDot.visible = false;
			this.intersectionGuide.update(null);
			return;
		}

		// Update Connector Dot
		this.updateConnectorDot(hit, snapResult?.kind);

		if (!this.isDrawing || !this.anchor) return;

		event.preventDefault();
		event.stopPropagation();

		this.updatePreview(this.anchor, hit);

		if (this.dimOverlay) {
			const w = Math.abs(hit.x - this.anchor.x).toFixed(2);
			const l = Math.abs(hit.z - this.anchor.z).toFixed(2);
			this.dimOverlay.placeholder = `${w}m x ${l}m`;
		}
	};

	private updateConnectorDot(pos: THREE.Vector3, snapKind?: string) {
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
			this.connectorDot.renderOrder = 9999;
			this.connectorDot.userData.isHelper = true;
			this.scene.add(this.connectorDot);
		}

		this.connectorDot.visible = true;
		this.connectorDot.position.copy(pos);
		const mat = this.connectorDot.material;

		if (snapKind === "endpoint") mat.color.setHex(0x00ff00);
		else if (snapKind === "midpoint") mat.color.setHex(0x00ffff);
		else mat.color.setHex(0xffffff);
	}

	private onKeyDown = (event: KeyboardEvent) => {
		if (!this.enabled) return;
		if (event.key === "Escape") this.cancel();
	};

	private getSnappedPoint(event: PointerEvent): { point: THREE.Vector3, kind?: string } | null {
		const rect = this.container.getBoundingClientRect();
		this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

		this.raycaster.setFromCamera(this.mouse, this.getCamera());

		const groundY = this.getGroundY();
		this.planeXZ.constant = -(groundY + SURFACE_OFFSET);

		const rawHit = new THREE.Vector3();
		if (!this.raycaster.ray.intersectPlane(this.planeXZ, rawHit)) return null;

		// 1. Snapping
		const currentPoints = this.anchor ? [this.anchor] : [];
		const snap = this.snappingHelper.getBestSnapByScreen(
			new THREE.Vector2(event.clientX, event.clientY),
			currentPoints,
			15
		);

		// 2. Intersection (only if drawing)
		let intersectResult = null;
		if (this.isDrawing && this.anchor) {
			const candidates = this.snappingHelper.getSceneVertices({ limit: 200 });
			intersectResult = this.intersectionHelper.getBestIntersection(
				this.anchor,
				candidates,
				new THREE.Vector2(event.clientX, event.clientY),
				15
			);
		}

		this.intersectionGuide.update(intersectResult);

		if (snap) return { point: snap.point, kind: snap.kind };
		if (intersectResult) return { point: intersectResult.point, kind: 'intersection' };

		return { point: rawHit };
	}

	private getGroundY() {
		const groundRef =
			this.scene.getObjectByName("Grid") ?? this.scene.getObjectByName("AxesWorld");
		return groundRef ? groundRef.getWorldPosition(this.tempVec3).y : 0;
	}

	private updatePreview(p1: THREE.Vector3, p2: THREE.Vector3) {
		const minX = Math.min(p1.x, p2.x);
		const maxX = Math.max(p1.x, p2.x);
		const minZ = Math.min(p1.z, p2.z);
		const maxZ = Math.max(p1.z, p2.z);

		const width = maxX - minX;
		const length = maxZ - minZ;
		const cx = minX + width / 2;
		const cz = minZ + length / 2;

		if (!this.previewMesh) {
			const geom = new THREE.PlaneGeometry(1, 1);
			geom.rotateX(-Math.PI / 2);
			this.previewMesh = new THREE.Mesh(geom, makeMaterial(0x99ccff));
			this.previewMesh.userData.isHelper = true;
			this.previewMesh.userData.selectable = false;
			this.scene.add(this.previewMesh);
		}

		this.previewMesh.position.set(cx, p1.y, cz);
		this.previewMesh.scale.set(width, 1, length);

		if (!this.previewEdge) {
			const pts = [
				new THREE.Vector3(-0.5, 0, -0.5),
				new THREE.Vector3(0.5, 0, -0.5),
				new THREE.Vector3(0.5, 0, 0.5),
				new THREE.Vector3(-0.5, 0, 0.5),
			];
			const g = new THREE.BufferGeometry().setFromPoints(pts);
			this.previewEdge = new THREE.LineLoop(g, makeEdgeMaterial());
			this.previewEdge.userData.isHelper = true;
			this.previewEdge.userData.selectable = false;
			this.previewEdge.renderOrder = 1001;
			this.scene.add(this.previewEdge);
		}

		this.previewEdge.position.set(cx, p1.y + OUTLINE_OFFSET, cz);
		this.previewEdge.scale.set(width, 1, length);
	}

	private finalize() {
		if (!this.previewMesh || !this.anchor) return;

		const width = this.previewMesh.scale.x;
		const length = this.previewMesh.scale.z;
		const cx = this.previewMesh.position.x;
		const cz = this.previewMesh.position.z;
		const cy = this.anchor.y;

		const geometry = new THREE.PlaneGeometry(1, 1);
		geometry.rotateX(-Math.PI / 2);
		const mesh = new THREE.Mesh(geometry, makeMaterial(0xcccccc));
		mesh.position.set(cx, cy, cz);
		mesh.scale.set(width, 1, length);

		mesh.userData = {
			...(mesh.userData || {}),
			type: "surface",
			mode: "rect",
			label: "Rectangle",
			category: "Plane/Sketch",
			QreaseeCategory: "Floor",
			selectable: true,
			locked: false,
			depth: 0,
			surfaceMeta: {
				kind: "rect",
				center: [cx, cz],
				width,
				length,
				normal: { x: 0, y: 1, z: 0 },
			},
		};

		splitFloorsWithNewRect(this.scene, mesh, { depth: 0 });
		this.cleanup();
	}

	private cancel() {
		this.cleanup();
	}

	private cleanup() {
		this.isDrawing = false;
		this.anchor = null;

		if (this.previewMesh) {
			this.previewMesh.removeFromParent();
			this.previewMesh.geometry.dispose();
			(this.previewMesh.material as THREE.Material).dispose();
			this.previewMesh = null;
		}

		if (this.previewEdge) {
			this.previewEdge.removeFromParent();
			this.previewEdge.geometry.dispose();
			(this.previewEdge.material as THREE.Material).dispose();
			this.previewEdge = null;
		}

		if (this.dimOverlay) {
			this.dimOverlay.remove();
			this.dimOverlay = null;
		}

		this.intersectionGuide.update(null);

		if (this.connectorDot) {
			this.connectorDot.visible = false;
		}
	}

	private showDimInput(x: number, y: number) {
		if (this.dimOverlay) return;

		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "0m x 0m";
		Object.assign(input.style, {
			position: "fixed",
			left: `${x + 10}px`,
			top: `${y + 10}px`,
			zIndex: "1000",
			padding: "4px",
			borderRadius: "4px",
			border: "1px solid #ccc",
			background: "rgba(255,255,255,0.95)",
		});

		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;

			const parts = input.value.trim().split(/[x, ]+/).filter(Boolean);
			if (parts.length < 2) return;

			const w = parseFloat(parts[0]);
			const l = parseFloat(parts[1]);

			if (Number.isFinite(w) && Number.isFinite(l) && w > 0 && l > 0 && this.anchor) {
				this.updatePreview(
					this.anchor,
					new THREE.Vector3(this.anchor.x + w, this.anchor.y, this.anchor.z + l)
				);
				this.finalize();
			}
		});

		document.body.appendChild(input);
		this.dimOverlay = input;
		setTimeout(() => input.focus(), 10);
	}
}

import './style.css'
import * as THREE from "three";

import { SkyDomeHelper, SkyDomeUI } from '../helpers/skydome';
import { setupFaceSelection } from "../components/FaceSelection";
import { AxesGizmo } from "../components/Gizmo";
import { type CameraProjectionMode, createCameraScene } from "../components/CameraScene";
import { setupGrid } from "../components/Grid";
import { AxesWorld } from "../utils/axesWorld";
import { setupLeftSidebar } from "../components/ui/LeftSidebar";
import { setupRightSidebar, type RightSidebarHandle } from "../components/ui/RightSidebar";
import { setupLayoutModel } from "../components/ui/LayoutModel";
import { setupDock, type DockToolId } from "../components/ui/Dock";
import { setupNavigationInputBindings } from "../helpers/navigationInputs";
import { createSelectionMarquee, type SelectionRect } from "../components/tools/SelectionMarquee";
import { LineTool } from "../components/Line";
import { RectangleTool } from "../components/surface/Rectangle";
import { CircleTool } from "../components/surface/Circle";
import { ArcTool } from "../components/Arc";
import { PolygonTool } from "../components/surface/Polygon";
import { MoveTool } from "../components/Move";
import { ExtrudeTool } from "../components/Extrude";
import { ElevationCameraControls } from "../components/ElevationCameraScene";
import { FileController, type ImportOutcome } from "../components/tools/fileController";
import { SectionTool } from "../components/SectionPlaneMode";
import { getCoplanarFaceRegionLocalToRoot, type FaceRegion, type FaceTriangle } from "../utils/faceRegion";
import { GroupManager } from "../components/Group";
import { SnapTool } from "../components/tools/SnapTool";
import { createPhongMaterial } from "../utils/materials";

type NavigationModeOption = "Orbit" | "Plan";

const isProjectionMode = (value: string): value is CameraProjectionMode =>
	value === "Perspective" || value === "Orthographic";
const isNavigationMode = (value: string): value is NavigationModeOption =>
	value === "Orbit" || value === "Plan";

const init = async () => {
	let elevationControls: ElevationCameraControls;

	// Instantiate SnapTool
	const snapTool = new SnapTool();

	const leftSidebar = setupLeftSidebar(undefined, {
		onDefault: () => elevationControls?.setPerspective(),
		onElevation: (dir) => elevationControls?.setElevationView(dir),
		onUnitChange: (u) => console.log("unit", u),
		onToleranceChange: (v) => console.log("tolerance", v),
		onParallelSnapChange: (v) => snapTool.setParallelSnap(v),
		onPerpendicularSnapChange: (v) => snapTool.setPerpendicularSnap(v),
	});

	// Setup RightSidebar (Message UI)
	const rightSidebar = setupRightSidebar();

	const container = document.getElementById("threejs");
	if (!container) throw new Error("Container element #threejs tidak ditemukan");

	// 1. Setup Camera Scene
	const cameraScene = await createCameraScene(container, {
		background: 0x000000,
		lookAt: { position: [0, 0, 5], target: [0, 0, 0] },
	});
	setupNavigationInputBindings(cameraScene);
	cameraScene.canvas.classList.add("three-main-canvas");

	// Konfigurasi Mouse Controls (Opsional: Sesuaikan jika ingin gaya Revit/BIM)
	// Default Three.js: LEFT=Orbit, MIDDLE=Dolly, RIGHT=Pan
	if (cameraScene.camera.controls) {
		cameraScene.camera.controls.mouseButtons.left = THREE.MOUSE.ROTATE;
		cameraScene.camera.controls.mouseButtons.middle = THREE.MOUSE.DOLLY;
		cameraScene.camera.controls.mouseButtons.right = THREE.MOUSE.PAN;
	}

	// 2. Setup Gizmo
	setupGizmo(container, cameraScene);

	// 3. Setup Environment (Grid, SkyDome)
	const { skyHelper } = setupEnvironment(cameraScene);

	// 4. Setup Test Objects (Cube)
	const testObjectData = createTestCube(cameraScene.scene);

	// 5. Setup Face Selection
	const faceSelection = setupFaceSelection({
		scene: cameraScene.scene,
		faceObject: testObjectData.cube,
		objectGeometry: testObjectData.cubeGeometry,
		faceMaterials: testObjectData.faceMaterials,
		faceBaseColor: testObjectData.faceBaseColor,
		faceHoverColor: testObjectData.faceHoverColor,
		canvas: cameraScene.canvas,
		camera: cameraScene.camera.three,
		getCamera: () => cameraScene.camera.three,
		dotSpacing: 0.05,
		surfaceOffset: 0.001,
		dotColor: 0x0000ff,
		dotSize: 1.2,
		borderColor: 0x0000ff,
		borderLineWidth: 2,
	});

	// 6. Setup Group Manager
	const groupManager = new GroupManager(cameraScene.scene);

	// 7. Setup Selection System
	const selectionSystem = setupSelectionSystem(container, cameraScene, faceSelection, groupManager);

	// 7. Setup Tools (Line, Snap)
	const getCamera = () => cameraScene.camera.three;
	const lineTool = new LineTool(
		cameraScene.scene,
		getCamera,
		container
	);
	const rectangleTool = new RectangleTool(
		cameraScene.scene,
		getCamera,
		container,
		{ setCameraZoom: (enabled) => cameraScene.setZoomEnabled(enabled) }
	);
	const circleTool = new CircleTool(
		cameraScene.scene,
		getCamera,
		container,
		{ setCameraZoom: (enabled) => cameraScene.setZoomEnabled(enabled) }
	);
	const arcTool = new ArcTool(
		cameraScene.scene,
		getCamera,
		container,
		{ setCameraZoom: (enabled) => cameraScene.setZoomEnabled(enabled) }
	);

	const polygonTool = new PolygonTool(
		cameraScene.scene,
		getCamera,
		container,
		{ setCameraZoom: (enabled) => cameraScene.setZoomEnabled(enabled) }
	);
	const moveTool = new MoveTool(
		cameraScene.scene,
		getCamera,
		container
	);
	const extrudeTool = new ExtrudeTool(getCamera, container, {
		getSelectedObjects: () => selectionSystem.selectedObjects,
		getControls: () => cameraScene.camera.controls as any,
		getScene: () => cameraScene.scene,
		onHover: (obj, idx) => faceSelection.setHovered(obj, idx),
		onPickFace: (obj, normal, region) => selectionSystem.setPrimaryFace(obj, normal, region),
		wallThickness: 0.15,
		floorThickness: 0.1,
	});

	const sectionTool = new SectionTool(
		cameraScene,
		leftSidebar,
		container
	);

	// Timeline Color Sync Logic
	skyHelper.onTimeChange = (hour: number) => {
		// Night: < 6.0 or > 18.5
		// Day: >= 6.5 and <= 18.0
		// Transition: 6.0-6.5 (Night->Day) and 18.0-18.5 (Day->Night)

		// Calculate "Night Factor": 0=Day (Black lines), 1=Night (White lines)
		let nightFactor = 0;

		if (hour < 6.0 || hour >= 18.5) {
			nightFactor = 1;
		} else if (hour >= 6.5 && hour <= 18.0) {
			nightFactor = 0;
		} else if (hour >= 6.0 && hour < 6.5) {
			// Morning Fade: 6.0 (Night/White) -> 6.5 (Day/Black)
			// alpha 0 -> 1 means Night -> Day
			const alpha = (hour - 6.0) / 0.5;
			nightFactor = 1 - alpha;
		} else if (hour >= 18.0 && hour < 18.5) {
			// Evening Fade: 18.0 (Day/Black) -> 18.5 (Night/White)
			const alpha = (hour - 18.0) / 0.5;
			nightFactor = alpha;
		}

		const dayColor = new THREE.Color(0x000000);
		const nightColor = new THREE.Color(0xffffff);
		const targetColor = dayColor.clone().lerp(nightColor, nightFactor);

		// Update Lines in the scene
		cameraScene.scene.traverse((obj: THREE.Object3D) => {
			// 1. Face Outlines (created by LineTool/FaceSelection)
			const isOutline = (obj.userData as any)?.isFaceOutline === true;

			// 2. User Drawn Lines (LineTool)
			// Check if it's a Line/LineSegments, manually selectable, and NOT a helper/grid
			const isUserLine = (obj as any).isLine &&
				(obj.userData as any)?.selectable === true &&
				!(obj.userData as any)?.isHelper;

			if (isOutline || isUserLine) {
				const mesh = obj as THREE.Line | THREE.LineSegments;
				if (mesh.material) {
					// Handle single material or array
					const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
					mats.forEach(m => {
						if ((m as THREE.LineBasicMaterial).color) {
							(m as THREE.LineBasicMaterial).color.copy(targetColor);
							m.needsUpdate = true;
						}
					});
				}
			}
		});

		// Request render update
		const worldRenderer = cameraScene.world.renderer;
		if (worldRenderer) worldRenderer.needsUpdate = true;

		// Update LineTool Preview Color
		lineTool.setPreviewColor(targetColor);
	};

	// Trigger initial update (default time 6:00)
	skyHelper.updateTime(6);

	// 8. Setup UI Bindings
	setupUIBindings(cameraScene);

	// 9. Setup Dock & Tool State Management
	// Layout Model Setup
	await setupLayoutModel(cameraScene);

	const dock = await setupDockSystem(
		cameraScene,
		lineTool,
		rectangleTool,
		circleTool,
		arcTool,
		polygonTool,
		moveTool,
		extrudeTool,
		selectionSystem,
		faceSelection,
		sectionTool,
		rightSidebar
	);

	leftSidebar.onSectionAdd(() => dock.setActiveTool("section"));
	// rightSidebar.onSectionAdd(() => dock.setActiveTool("section"));

	// 10. Setup Elevation & Camera Controls
	elevationControls = new ElevationCameraControls(cameraScene);
	(window as any).qreaseeCamera = {
		perspective: () => elevationControls.setPerspective(),
		orthographicIso: () => elevationControls.setIsoView(),
		orthographicTop: () => elevationControls.setTopView(),
		fitScene: () => elevationControls.fitScene(),
		setElevation: (dir: string) => elevationControls.setElevationView(dir as any),
	};

	// 11. Setup Importer
	try {
		const importer = document.getElementById("importer") as HTMLInputElement | null;
		if (!importer) throw new Error("Importer element #importer tidak ditemukan");

		const fileController = new FileController(cameraScene.scene, cameraScene.components);
		fileController.setupImport(importer);

		const fitImported = async (outcome: ImportOutcome) => {
			if (!outcome.ok) return;

			const bounds = outcome.stats.bounds;
			if (bounds) {
				const half = bounds.size.clone().multiplyScalar(0.5);
				const box = new THREE.Box3(
					bounds.center.clone().sub(half),
					bounds.center.clone().add(half)
				);

				const controls = cameraScene.camera.controls;
				if (controls?.fitToBox) {
					await controls.fitToBox(box, true, {
						paddingLeft: 0.15,
						paddingRight: 0.15,
						paddingBottom: 0.15,
						paddingTop: 0.15,
					});
				} else {
					elevationControls.fitScene(outcome.root);
				}

				const cam = cameraScene.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
				const radius = bounds.size.length() * 0.5;
				cam.near = Math.max(0.01, radius / 1000);
				cam.far = Math.max(cam.near * 1000, radius * 50, 5000);
				cam.updateProjectionMatrix();
			} else {
				elevationControls.fitScene(outcome.root);
			}

			const worldRenderer = cameraScene.world.renderer;
			if (worldRenderer) worldRenderer.needsUpdate = true;
		};

		const importButton = document.getElementById("importButton") as HTMLButtonElement | null;
		const updateImportButton = () => {
			if (!importButton) return;
			const label = fileController.getPendingImportLabel();
			importButton.disabled = !label;
			importButton.title = label ? `Import: ${label}` : "Pilih file dulu, lalu klik Import";
		};
		updateImportButton();
		importer.addEventListener("change", updateImportButton);

		if (importButton) {
			importButton.addEventListener("click", async () => {
				const outcome = await fileController.importPending();
				await fitImported(outcome);
				updateImportButton();
			});
		}

		const exportButton = document.getElementById("exportButton") as HTMLButtonElement | null;
		const exporterFormat = document.getElementById("exporterFormat") as HTMLSelectElement | null;
		if (exportButton && exporterFormat) {
			exportButton.addEventListener("click", () => {
				const format = exporterFormat.value;
				if (format === "glb" || format === "obj" || format === "ifc" || format === "frag" || format === "schema") {
					void fileController.export(format);
				}
			});
		}
	} catch (error) {
		console.warn("File importer gagal diinisialisasi:", error);
	}


};

// --- Helper Functions ---

const setupGizmo = (container: HTMLElement, cameraScene: any) => {
	const gizmoCanvas = document.createElement("canvas");
	gizmoCanvas.classList.add("axes-gizmo");
	gizmoCanvas.setAttribute("aria-label", "camera axes gizmo");
	// Pastikan gizmo tidak menutupi seluruh layar (blocking events)
	gizmoCanvas.style.position = "absolute";
	gizmoCanvas.style.top = "70px";
	gizmoCanvas.style.right = "78px";
	gizmoCanvas.style.left = "auto";
	gizmoCanvas.style.zIndex = "100";
	container.appendChild(gizmoCanvas);

	const axesGizmo = new AxesGizmo(
		cameraScene.camera.three,
		cameraScene.camera.controls,
		gizmoCanvas
	);

	const updateGizmoCamera = () => {
		axesGizmo.setCamera(cameraScene.camera.three);
	};
	const renderGizmo = () => axesGizmo.update();

	const worldRenderer = cameraScene.world.renderer;
	if (worldRenderer) {
		worldRenderer.onAfterUpdate.add(renderGizmo);
	}

	cameraScene.onProjectionChanged(() => updateGizmoCamera());
	updateGizmoCamera();
};

const setupEnvironment = (cameraScene: any) => {
	setupGrid(cameraScene, { yOffset: 0.0 });
	// Non-aktifkan raycasting pada GridHelper agar tidak mengganggu Orbit
	cameraScene.scene.traverse((child: any) => {
		if (child.isGridHelper) child.raycast = () => { };
	});

	// Axes World Setup
	const axesWorld = new AxesWorld();
	axesWorld.position.y = 0.0;
	// Non-aktifkan raycasting pada AxesWorld agar tidak mengganggu Orbit/Line tool
	axesWorld.traverse((child) => {
		child.raycast = () => { };
	});
	cameraScene.scene.add(axesWorld);

	// SkyDome Setup
	const skyHelper = new SkyDomeHelper(cameraScene.scene);

	new SkyDomeUI(skyHelper);
	return { skyHelper };
};

const createTestCube = (scene: THREE.Scene) => {
	const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
	const faceBaseColor = 0xcccccc;
	const faceHoverColor = 0xe6e6e6;
	const faceMaterials = Array.from(
		{ length: 6 },
		() => createPhongMaterial({ color: faceBaseColor })
	);
	const cube = new THREE.Mesh(cubeGeometry, faceMaterials);
	cube.userData.selectable = true;
	scene.add(cube);

	const edge = new THREE.EdgesGeometry(cubeGeometry);
	const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
	const outline = new THREE.LineSegments(edge, outlineMaterial);
	outline.userData.selectable = false;
	outline.scale.setScalar(1.0);
	cube.add(outline);

	return { cube, cubeGeometry, faceMaterials, faceBaseColor, faceHoverColor };
};

const setupSelectionSystem = (
	container: HTMLElement,
	cameraScene: any,
	faceSelection: any,
	groupManager: GroupManager
) => {
	const scene = cameraScene.scene;
	const selectedObjects = new Set<THREE.Object3D>();
	// const selectionColor = new THREE.Color(0x4f8cff);
	let primarySelectedObject: THREE.Object3D | null = null;
	let primarySelectedNormal: THREE.Vector3 | null = null;
	let primarySelectedRegion: FaceRegion | null = null;

	const isSelectableRoot = (object: THREE.Object3D) =>
		(object.userData as { selectable?: boolean } | undefined)?.selectable === true;

	const getSelectableRoots = () => {
		const roots: THREE.Object3D[] = [];
		scene.traverse((obj: any) => {
			if (isSelectableRoot(obj)) roots.push(obj);
		});
		return roots;
	};

	const cloneSelectedRegion = (region?: FaceRegion) => {
		if (!region) return null;
		return {
			triangles: region.triangles.map(
				(tri) => [tri[0].clone(), tri[1].clone(), tri[2].clone()] as FaceTriangle
			),
		};
	};

	const syncFaceSelection = (
		primaryObject?: THREE.Object3D,
		primaryNormal?: THREE.Vector3,
		primaryRegion?: FaceRegion
	) => {
		if (primaryObject) {
			primarySelectedObject = primaryObject;
			primarySelectedNormal = primaryNormal ? primaryNormal.clone() : null;
			primarySelectedRegion = cloneSelectedRegion(primaryRegion);
		}

		if (primarySelectedObject && !selectedObjects.has(primarySelectedObject)) {
			primarySelectedObject = null;
			primarySelectedNormal = null;
			primarySelectedRegion = null;
		}

		if (!primarySelectedObject && selectedObjects.size > 0) {
			primarySelectedObject = selectedObjects.values().next().value ?? null;
			primarySelectedNormal = null;
			primarySelectedRegion = null;
		}

		if (selectedObjects.size > 0) {
			const items = Array.from(selectedObjects).map((obj) => {
				if (obj === primarySelectedObject) {
					return {
						object: obj,
						normal: primarySelectedNormal ?? undefined,
						region: primarySelectedRegion ?? undefined,
					};
				}
				return { object: obj };
			});
			faceSelection.setSelectedObjects(items);
		} else {
			faceSelection.setSelectedObjects([]);
		}
	};

	const setObjectSelection = (object: THREE.Object3D, selected: boolean) => {
		object.traverse((child) => {
			if ((child.userData as { selectable?: boolean } | undefined)?.selectable === false) return;
			if (!(child as any).isMesh && !(child as any).isLine && !(child as any).isLineSegments) return;

			const materialValue = (child as any).material as THREE.Material | THREE.Material[] | undefined;
			if (!materialValue) return;
			const materials = Array.isArray(materialValue) ? materialValue : [materialValue];

			materials.forEach((material) => {
				const mat = material as THREE.Material & { color?: THREE.Color };
				if (!mat || !(mat as any).color) return;
				// Selection highlight disabled as per user request
				// if (selected) {
				// 	if (mat.userData.__originalColor === undefined) {
				// 		mat.userData.__originalColor = mat.color.getHex();
				// 	}
				// 	mat.color.copy(selectionColor);
				// } else if (mat.userData.__originalColor !== undefined) {
				// 	mat.color.setHex(mat.userData.__originalColor);
				// 	delete mat.userData.__originalColor;
				// }
				void selected; // Silence unused variable warning
			});
		});
	};

	const selectObjectsInRect = (rect: SelectionRect) => {
		const camera = cameraScene.camera.three;
		const box = new THREE.Box3();
		const corners = Array(8).fill(null).map(() => new THREE.Vector3());

		const projectToScreen = (vec: THREE.Vector3) => {
			const projected = vec.clone().project(camera);
			return { x: (projected.x + 1) / 2, y: (-projected.y + 1) / 2 };
		};

		const selected: THREE.Object3D[] = [];
		getSelectableRoots().forEach((object) => {
			box.setFromObject(object);
			if (box.isEmpty()) return;

			corners[0].set(box.min.x, box.min.y, box.min.z);
			corners[1].set(box.min.x, box.min.y, box.max.z);
			corners[2].set(box.min.x, box.max.y, box.min.z);
			corners[3].set(box.min.x, box.max.y, box.max.z);
			corners[4].set(box.max.x, box.min.y, box.min.z);
			corners[5].set(box.max.x, box.min.y, box.max.z);
			corners[6].set(box.max.x, box.max.y, box.min.z);
			corners[7].set(box.max.x, box.max.y, box.max.z);

			const inside = corners.some((corner) => {
				const screen = projectToScreen(corner);
				return (
					screen.x >= rect.left && screen.x <= rect.right &&
					screen.y >= rect.top && screen.y <= rect.bottom
				);
			});

			if (inside) selected.push(object);
		});
		return selected;
	};

	const updateSelections = (rect: SelectionRect, selectionOptions?: { additive?: boolean }) => {
		const newlySelected = selectObjectsInRect(rect);
		if (!selectionOptions?.additive) {
			Array.from(selectedObjects).forEach((obj) => {
				if (!newlySelected.includes(obj)) {
					setObjectSelection(obj, false);
					selectedObjects.delete(obj);
				}
			});
		}
		newlySelected.forEach((obj) => {
			if (!selectedObjects.has(obj)) {
				setObjectSelection(obj, true);
				selectedObjects.add(obj);
			}
		});
		syncFaceSelection();
	};

	const selectionMarquee = createSelectionMarquee(container, {
		onSelection: (rect, event) => {
			if (selectionSystem.currentTool === "group") {
				const objectsInRect = selectObjectsInRect(rect);
				if (objectsInRect.length > 0) {
					const group = groupManager.createGroupFromObjects(objectsInRect);
					if (group) {
						// Select the new group
						clearSelection();
						setObjectSelection(group, true);
						selectedObjects.add(group);
						syncFaceSelection();
					}
				}
			} else {
				updateSelections(rect, { additive: event.shiftKey });
			}
		},
	});

	const selectionRaycaster = new THREE.Raycaster();
	const selectionPointer = new THREE.Vector2();

	const findSelectableRoot = (obj: THREE.Object3D) => {
		let current: THREE.Object3D | null = obj;
		while (current && current !== scene) {
			if (isSelectableRoot(current)) return current;
			current = current.parent;
		}
		return null;
	};

	const clearSelection = () => {
		selectedObjects.forEach((obj) => setObjectSelection(obj, false));
		selectedObjects.clear();
		primarySelectedObject = null;
		primarySelectedNormal = null;
		primarySelectedRegion = null;
		syncFaceSelection();
	};

	const selectSingleObject = (object: THREE.Object3D, normal?: THREE.Vector3, region?: FaceRegion) => {
		Array.from(selectedObjects).forEach((obj) => {
			if (obj === object) return;
			setObjectSelection(obj, false);
			selectedObjects.delete(obj);
		});
		if (!selectedObjects.has(object)) {
			setObjectSelection(object, true);
			selectedObjects.add(object);
		}
		syncFaceSelection(object, normal, region);
	};

	const toggleObjectSelection = (object: THREE.Object3D, normal?: THREE.Vector3, region?: FaceRegion) => {
		if (selectedObjects.has(object)) {
			setObjectSelection(object, false);
			selectedObjects.delete(object);
			if (primarySelectedObject === object) {
				primarySelectedObject = selectedObjects.values().next().value ?? null;
				primarySelectedNormal = null;
				primarySelectedRegion = null;
			}
			syncFaceSelection();
		} else {
			setObjectSelection(object, true);
			selectedObjects.add(object);
			syncFaceSelection(object, normal, region);
		}
	};

	let lastClickTime = -Infinity;
	const DOUBLE_CLICK_DELAY = 300;

	const onCanvasPointerUp = (event: PointerEvent) => {
		if (selectionSystem.currentTool !== "select") return;

		if (event.button !== 0) return;
		if (selectionMarquee.isDragging()) return;

		const rect = cameraScene.canvas.getBoundingClientRect();
		selectionPointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		selectionPointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

		selectionRaycaster.setFromCamera(selectionPointer, cameraScene.camera.three);
		const hits = selectionRaycaster.intersectObjects(getSelectableRoots(), true);

		const isPickableHit = (hit: THREE.Intersection) => {
			const obj = hit.object as any;
			if (!obj) return false;
			if (obj.userData?.isHelper) return false;
			if (obj.userData?.selectable === false) return false;
			if (obj.name === "SkyDome" || obj.name === "Grid" || obj.name === "AxesWorld") return false;
			return true;
		};

		const firstHit = hits.find(isPickableHit);
		const root = firstHit ? findSelectableRoot(firstHit.object) : null;

		const faceNormalToRoot = (intersection: THREE.Intersection, targetRoot: THREE.Object3D) => {
			if (!intersection.face?.normal) return undefined;
			const worldNormal = intersection.face.normal
				.clone()
				.transformDirection(intersection.object.matrixWorld)
				.normalize();

			const invRootQuat = new THREE.Quaternion();
			targetRoot.getWorldQuaternion(invRootQuat);
			invRootQuat.invert();
			return worldNormal.applyQuaternion(invRootQuat).normalize();
		};

		const now = performance.now();
		const isDoubleClick = (now - lastClickTime) < DOUBLE_CLICK_DELAY;
		lastClickTime = now;

		if (!root) {
			if (!event.shiftKey) clearSelection();
			return;
		}

		const meshHitForRoot = hits.find((h) => {
			if (!isPickableHit(h)) return false;
			if (findSelectableRoot(h.object) !== root) return false;
			return (h.object as any).isMesh === true && !!h.face?.normal;
		});

		const normalForRoot = meshHitForRoot ? faceNormalToRoot(meshHitForRoot, root) : undefined;
		const regionForRoot = meshHitForRoot
			? getCoplanarFaceRegionLocalToRoot(meshHitForRoot, root) ?? undefined
			: undefined;

		if (event.shiftKey) {
			toggleObjectSelection(root, normalForRoot, regionForRoot);
		} else {
			if (isDoubleClick) {
				// Double click: Select whole object (no normal restriction)
				selectSingleObject(root, undefined, undefined);
			} else {
				// Single click: Select specific face
				selectSingleObject(root, normalForRoot, regionForRoot);
			}
		}
	};

	cameraScene.canvas.addEventListener("pointerup", onCanvasPointerUp);

	const selectionSystem = {
		selectedObjects,
		selectionMarquee,
		syncFaceSelection,
		currentTool: "select" as DockToolId,
		setSelectionHighlightEnabled: (enabled: boolean) => {
			selectedObjects.forEach((obj) => setObjectSelection(obj, enabled));
		},
		clearSelection,
		selectSingle: (object: THREE.Object3D, normal?: THREE.Vector3, region?: FaceRegion) =>
			selectSingleObject(object, normal, region),
		setPrimaryFace: (object: THREE.Object3D, normal?: THREE.Vector3, region?: FaceRegion) => {
			if (!selectedObjects.has(object)) {
				selectSingleObject(object, normal, region);
				return;
			}
			syncFaceSelection(object, normal, region);
		},
		selectAll: () => {
			const roots = getSelectableRoots();
			selectedObjects.forEach((obj) => setObjectSelection(obj, false));
			selectedObjects.clear();
			roots.forEach((obj) => {
				setObjectSelection(obj, true);
				selectedObjects.add(obj);
			});
			syncFaceSelection();
		},
		deleteSelected: async () => {
			const toDelete = Array.from(selectedObjects);
			toDelete.forEach((obj) => setObjectSelection(obj, false));
			selectedObjects.clear();
			syncFaceSelection();

			const disposeMaterial = (material: THREE.Material) => {
				const anyMaterial = material as any;
				Object.values(anyMaterial).forEach((value) => {
					if (value && typeof value === "object" && (value as any).isTexture) {
						try {
							(value as THREE.Texture).dispose();
						} catch { }
					}
				});
				material.dispose();
			};

			const disposeObject3D = (object: THREE.Object3D) => {
				object.traverse((child: any) => {
					if (child.geometry?.dispose) {
						try {
							child.geometry.dispose();
						} catch { }
					}

					const mat = child.material as THREE.Material | THREE.Material[] | undefined;
					if (!mat) return;
					if (Array.isArray(mat)) mat.forEach(disposeMaterial);
					else disposeMaterial(mat);
				});
			};

			for (const obj of toDelete) {
				const fragmentsModel = (obj.userData as any)?.__fragmentsModel as
					| { dispose?: () => Promise<void> | void }
					| undefined;
				if (fragmentsModel?.dispose) {
					try {
						await fragmentsModel.dispose();
					} catch { }
				}

				obj.removeFromParent();
				disposeObject3D(obj);
			}
		},
	};
	return selectionSystem;
};

const setupUIBindings = (cameraScene: any) => {
	const projectionSelect = document.getElementById("projectionMode") as HTMLSelectElement | null;
	const projectionToggle = document.getElementById("projectionToggle") as HTMLButtonElement | null;
	const navigationSelect = document.getElementById("navigationMode") as HTMLSelectElement | null;

	if (projectionSelect) {
		projectionSelect.value = cameraScene.getProjection();
		projectionSelect.addEventListener("change", async () => {
			if (!isProjectionMode(projectionSelect.value)) return;
			await cameraScene.setProjection(projectionSelect.value);
		});
	}

	if (projectionToggle) {
		projectionToggle.addEventListener("click", async () => {
			await cameraScene.toggleProjection();
		});
	}

	cameraScene.onProjectionChanged((projection: string) => {
		if (projectionSelect) projectionSelect.value = projection;
	});

	if (navigationSelect) {
		const updateNavigationSelect = (mode: string) => {
			if (isNavigationMode(mode)) navigationSelect.value = mode;
		};
		navigationSelect.addEventListener("change", () => {
			if (!isNavigationMode(navigationSelect.value)) return;
			cameraScene.setNavigationMode(navigationSelect.value);
		});

		const navigationToggle = document.getElementById("navigationToggle") as HTMLButtonElement | null;
		if (navigationToggle) {
			navigationToggle.addEventListener("click", () => {
				const current = navigationSelect.value;
				const next = current === "Orbit" ? "Plan" : "Orbit";
				if (isNavigationMode(next)) {
					cameraScene.setNavigationMode(next);
				}
			});
		}

		cameraScene.onNavigationModeChanged((mode: string) => updateNavigationSelect(mode));
	}
};

const setupDockSystem = async (
	cameraScene: any,
	lineTool: LineTool,
	rectangleTool: RectangleTool,
	circleTool: CircleTool,
	arcTool: ArcTool,

	polygonTool: PolygonTool,
	moveTool: MoveTool,
	extrudeTool: ExtrudeTool,
	selectionSystem: any,
	faceSelection: any,

	sectionTool: SectionTool,
	rightSidebar: RightSidebarHandle
) => {
	const updateSelectionState = (tool: DockToolId | null) => {
		selectionSystem.currentTool = tool ?? "select"; // Default to select or just null? If null, maybe "select" behavior logic needs checking.
		// If tool is null, we might want to just disable everything or fallback to select.
		// For now, let's treat null as "no tool active" or fallback to select if critical.
		// However, if we toggle chat off, we typically want to return to "select" or stay idle.
		// If the user untoggles chat, maybe we should auto-select "select"?

		selectionSystem.setSelectionHighlightEnabled?.(tool !== "extrude");

		// Reset all tools first
		lineTool.disable();
		rectangleTool.disable();
		circleTool.disable();
		arcTool.disable();

		polygonTool.disable();
		moveTool.disable();
		extrudeTool.disable();
		sectionTool.disable();
		selectionSystem.selectionMarquee.disable();
		faceSelection.setSelectionByNormal(null);

		if (tool === null) {
			// If no tool, maybe fallback to select? 
			// But Dock.ts setActive(null) doesn't highlight any button.
			// Users usually expect 'select' to be default. 
			// Let's just do nothing (idle) or enable select without button highlight?
			// Ideally, if chat toggles off, we just hide chat. What about the previous tool?
			// The dock doesn't remember previous tool.
			// Let's enable select as fallback for interaction but without dock highlight if that's what 'null' implies.
			// Actually, if tool is null, we can just return.
			// But interacting with canvas without 'select' might be weird if we need to select things.
			// Let's default to enabling selection marquee/logic if null?
			// Or just:
			selectionSystem.currentTool = "select";
			selectionSystem.selectionMarquee.enable();
			selectionSystem.syncFaceSelection();
			return;
		}

		if (tool === "select" || tool === "group") {
			selectionSystem.selectionMarquee.enable();
			selectionSystem.syncFaceSelection();
		} else if (tool === "line") {
			lineTool.enable();
		} else if (tool === "rectangle") {
			rectangleTool.enable();
		} else if (tool === "circle") {
			circleTool.enable();
		} else if (tool === "arc") {
			arcTool.enable();
		} else if (tool === "polygon") {
			polygonTool.enable();
		} else if (tool === "move") {
			moveTool.enable();
		} else if (tool === "extrude") {
			extrudeTool.enable();
		} else if (tool === "section") {
			sectionTool.enable();
		}
	};

	const dock = await setupDock({
		initialTool: "select",
		onToolChange: (tool) => {
			// Toggle Chat Sidebar
			rightSidebar.toggle(tool === "chat");

			updateSelectionState(tool);

			const controls = cameraScene.camera.controls;
			if (tool === "hand") {
				// Mode Hand: Pan dengan Left Click, tetap di Orbit (Perspective) agar bisa rotate via Right Click
				cameraScene.setNavigationMode("Orbit");
				if (controls) {
					controls.mouseButtons.left = THREE.MOUSE.PAN;
					controls.mouseButtons.right = THREE.MOUSE.ROTATE;
				}
			} else if (tool === "select") {
				cameraScene.setNavigationMode("Orbit");
				if (controls) {
					controls.mouseButtons.left = THREE.MOUSE.ROTATE;
					controls.mouseButtons.right = THREE.MOUSE.PAN;
				}
			} else if (tool === "line") {
				cameraScene.setNavigationMode("Plan");
			} else if (tool === "rectangle" || tool === "circle" || tool === "arc" || tool === "polygon") {
				// Opsional: Atur navigasi khusus jika diperlukan
			} else if (tool === "move") {
				cameraScene.setNavigationMode("Orbit");
				if (controls) {
					controls.mouseButtons.left = THREE.MOUSE.ROTATE;
					controls.mouseButtons.right = THREE.MOUSE.PAN;
				}
			} else if (tool === "extrude") {
				cameraScene.setNavigationMode("Orbit");
				if (controls) {
					controls.mouseButtons.left = THREE.MOUSE.ROTATE;
					controls.mouseButtons.right = THREE.MOUSE.PAN;
				}
			} else if (tool === "section") {
				cameraScene.setNavigationMode("Orbit");
				if (controls) {
					controls.mouseButtons.left = THREE.MOUSE.ROTATE;
					controls.mouseButtons.right = THREE.MOUSE.PAN;
				}
			} else if (tool === "group") {
				cameraScene.setNavigationMode("Orbit");
				if (controls) {
					controls.mouseButtons.left = THREE.MOUSE.ROTATE;
					controls.mouseButtons.right = THREE.MOUSE.PAN;
				}
			}
		},
	});

	cameraScene.setNavigationMode("Orbit");
	updateSelectionState("select");

	cameraScene.onNavigationModeChanged((mode: string) => {
		// Plan mode shouldn't forcibly override drawing tools (e.g. Line).
		const tool = selectionSystem.currentTool as DockToolId | string | null;
		const allowInPlan = new Set<DockToolId>(["hand", "line", "rectangle", "circle", "arc", "polygon"]);
		if (mode === "Plan" && (!tool || !allowInPlan.has(tool as DockToolId))) {
			dock.setActiveTool("hand", { silent: true });
			updateSelectionState("hand");
		}
	});

	window.addEventListener("keydown", (event) => {
		const activeElement = document.activeElement as HTMLElement | null;
		const isTyping =
			!!activeElement &&
			(activeElement.tagName === "INPUT" ||
				activeElement.tagName === "TEXTAREA" ||
				activeElement.tagName === "SELECT" ||
				activeElement.isContentEditable);

		if (selectionSystem.currentTool === "select" && !isTyping) {
			const key = event.key.toLowerCase();
			if ((event.ctrlKey || event.metaKey) && key === "a") {
				event.preventDefault();
				selectionSystem.selectAll();
				return;
			}

			if (event.key === "Backspace" || event.key === "Delete") {
				event.preventDefault();
				void selectionSystem.deleteSelected();
				return;
			}
		}

		if (event.key === "Escape") {
			if (selectionSystem.currentTool !== "select") {
				dock.setActiveTool("select");
			} else {
				selectionSystem.clearSelection();
			}
		}
	});

	return dock;
};

init();

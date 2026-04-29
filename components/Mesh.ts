import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as WEBIFC from "web-ifc";

import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { applyPhongMaterials } from "../utils/materials";

const workerUrl = "/worker.mjs";

export function markSelectableRoot(object: THREE.Object3D, extraUserData: Record<string, unknown> = {}) {
    object.userData = {
        ...object.userData,
        ...extraUserData,
        selectable: true,
    };

    // Prevent child nodes from becoming selectable roots.
    object.traverse((child) => {
        if (child === object) return;
        if ((child.userData as any)?.selectable === true) {
            delete (child.userData as any).selectable;
        }
    });
}

export class MeshLoader extends OBC.Component implements OBC.Disposable {
    enabled = true;
    readonly onDisposed = new OBC.Event();

    private _loaderGLTF = new GLTFLoader();
    private _loaderOBJ = new OBJLoader();
    private _ifcLoader: OBC.IfcLoader;

    constructor(components: OBC.Components) {
        super(components);
        this._ifcLoader = components.get(OBC.IfcLoader);
    }

    async setup() {
        const fragments = this.components.get(OBC.FragmentsManager);
        if (!fragments.initialized) {
            fragments.init(workerUrl);
        }

        await this._ifcLoader.setup({
            autoSetWasm: false,
            wasm: {
                path: "/wasm/",
                absolute: true,
                logLevel: WEBIFC.LogLevel.LOG_LEVEL_OFF,
            },
            webIfc: {
                ...this._ifcLoader.settings.webIfc,
                COORDINATE_TO_ORIGIN: true,
            },
        });
    }

    async load(file: File, options?: { position?: THREE.Vector3 }) {
        const extension = file.name.split('.').pop()?.toLowerCase();

        if (extension === 'gltf' || extension === 'glb') {
            return this.loadGLTF(file, options);
        } else if (extension === 'obj') {
            return this.loadOBJ(file, options);
        } else if (extension === 'ifc') {
            return this.loadIFC(file, options);
        } else {
            console.warn(`Unsupported file format: ${extension}`);
            return null;
        }
    }

    private async loadGLTF(file: File, options?: { position?: THREE.Vector3 }) {
        const url = URL.createObjectURL(file);
        try {
            const gltf = await this._loaderGLTF.loadAsync(url);
            const scene = gltf.scene;
            this.setupMesh(scene, options);
            return scene;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    private async loadOBJ(file: File, options?: { position?: THREE.Vector3 }) {
        const url = URL.createObjectURL(file);
        try {
            const group = await this._loaderOBJ.loadAsync(url);
            this.setupMesh(group, options);
            return group;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    private async loadIFC(file: File, options?: { position?: THREE.Vector3 }) {
        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);

        // Ensure setup is done (idempotent usually or check initialized)
        // Ideally setup() is called at app start, but lazy init here:
        if (!this._ifcLoader.settings.webIfc.COORDINATE_TO_ORIGIN) {
            await this.setup();
        }

        const model = await this._ifcLoader.load(data, true, file.name);
        if (options?.position) {
            model.object.position.copy(options.position);
        }

        // Setup metadata usage
        markSelectableRoot(model.object, { entityType: "ifc" });

        const world = this.getWorld();
        if (world) {
            world.scene.three.add(model.object);
        }

        return model;
    }

    private setupMesh(object: THREE.Object3D, options?: { position?: THREE.Vector3 }) {
        if (options?.position) {
            object.position.copy(options.position);
        }

        applyPhongMaterials(object);

        const defaultType = (object as any).isMesh ? "imported_mesh" : "imported_root";

        // Make the imported object selectable as a single unit (root),
        // so MoveTool moves the object instead of "separating" child meshes.
        markSelectableRoot(object, {
            entityType: (object.userData as any)?.entityType ?? "imported",
            type: (object.userData as any)?.type ?? defaultType,
        });

        object.traverse((child) => {
            if ((child as any).isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;

                if (child !== object) {
                    child.userData.type = "imported_mesh";
                }
            }
        });

        const world = this.getWorld();
        if (world) {
            world.scene.three.add(object);
        }
    }

    private getWorld() {
        const worlds = this.components.get(OBC.Worlds);
        // Get the first available world
        for (const [_id, world] of worlds.list) {
            if (world.scene && world.scene.three) {
                return world;
            }
        }
        return null;
    }

    dispose() {
        this.enabled = false;
        this.onDisposed.trigger();
    }
}

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as FRAGS from "@thatopen/fragments";
import * as flatbuffers from "flatbuffers";

import { importDwgOrDxf } from "./dwg";
import { importGlbOrGltf, exportGlb } from "./glb";
import { IfcManager } from "./ifc";
import { importObj, exportObj } from "./obj";
import { markSelectableRoot } from "../Mesh";
import { applyPhongMaterials } from "../../utils/materials";

export type ImportObjectStats = {
  meshCount: number;
  lineCount: number;
  pointsCount: number;
  vertexCount: number;
  triangleCount: number;
  bounds: { center: THREE.Vector3; size: THREE.Vector3 } | null;
};

export type ImportOutcome =
  | {
      ok: true;
      file: File;
      extension: string;
      root: THREE.Object3D;
      stats: ImportObjectStats;
      message: string;
    }
  | {
      ok: false;
      file?: File;
      extension?: string | null;
      message: string;
      error: Error;
    };

export type ExportFormat = "ifc" | "glb" | "obj" | "frag" | "schema";

class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

export class FileController {
  private scene: THREE.Scene;
  private components?: OBC.Components;
  private ifc?: IfcManager;
  private ifcSetupPromise: Promise<void> | null = null;

  private importInput: HTMLInputElement | null = null;
  private pendingImportFiles: File[] = [];

  private lastIfcModel: FRAGS.FragmentsModel | null = null;
  private lastIfcFileBaseName: string | null = null;

  constructor(scene: THREE.Scene, components?: OBC.Components) {
    this.scene = scene;
    this.components = components;
  }

  public setupImport(inputElement: HTMLInputElement) {
    this.importInput = inputElement;
    inputElement.addEventListener("change", async (event) => {
      const input = event.target as HTMLInputElement;
      this.pendingImportFiles = input.files ? Array.from(input.files) : [];
    });
  }

  public hasPendingImport() {
    return this.pendingImportFiles.length > 0;
  }

  public getPendingImportLabel() {
    if (!this.hasPendingImport()) return null;
    if (this.pendingImportFiles.length === 1) return this.pendingImportFiles[0]!.name;
    return `${this.pendingImportFiles.length} files`;
  }

  public clearPendingImport() {
    this.pendingImportFiles = [];
    if (this.importInput) this.importInput.value = "";
  }

  public async importPending(): Promise<ImportOutcome> {
    if (!this.hasPendingImport()) {
      const message = "Tidak ada file yang dipilih. Pilih file dulu, lalu klik Import.";
      console.warn(message);
      return { ok: false, message, extension: null, error: new Error(message) };
    }

    const files = this.pendingImportFiles.slice();

    // If multiple files are selected, prefer the .obj (OBJ+MTL+textures scenario).
    const objFile = files.find((f) => f.name.toLowerCase().endsWith(".obj"));
    const file = objFile ?? files[0]!;

    const extension = file.name.split(".").pop()?.toLowerCase();
    console.log(`Importing ${extension ?? "unknown"}...`);

    try {
      let imported = false;
      let root: THREE.Object3D | null = null;
      let stats: ImportObjectStats | null = null;
      let ifcItemsWithGeometry: number | null = null;

      if (!extension) {
        throw new ImportValidationError(`Nama file tidak punya ekstensi: '${file.name}'`);
      }

      switch (extension) {
        case "ifc": {
          await this.ensureIfcReady();
          const model = await this.ifc!.loadFile(file, true);
          markSelectableRoot(model.object as unknown as THREE.Object3D, {
            entityType: "ifc",
            __fragmentsModel: model,
          });
          this.lastIfcModel = model;
          this.lastIfcFileBaseName = this.getFileBaseName(file.name);

          this.bindFragmentsModelToActiveCamera(model);
          ifcItemsWithGeometry = await this.assertIfcHasGeometry(model, file);

          root = model.object as unknown as THREE.Object3D;
          stats = this.getIfcImportStats(model, root);

          this.scene.add(model.object);

          // Trigger an initial fragments update so tiles start showing up quickly.
          // Don't fail the import if this update errors for any reason.
          try {
            const fragments = this.components!.get(OBC.FragmentsManager);
            if (fragments.initialized) {
              await fragments.core.update(true);
            }
          } catch (e) {
            console.warn("Fragments update failed after IFC import (non-fatal):", e);
          }

          imported = true;
          break;
        }
        case "glb":
        case "gltf": {
          const object = await importGlbOrGltf(file);
          applyPhongMaterials(object);
          markSelectableRoot(object, { entityType: "model" });
          root = object;
          stats = this.getImportObjectStats(root);
          this.assertHasRenderableGeometry(stats, file);
          this.scene.add(object);
          imported = true;
          break;
        }
        case "obj": {
          const object = await importObj(file);
          applyPhongMaterials(object);
          markSelectableRoot(object, { entityType: "model" });
          root = object;
          stats = this.getImportObjectStats(root);
          this.assertHasRenderableGeometry(stats, file);
          this.scene.add(object);
          imported = true;
          break;
        }
        case "dwg":
        case "dxf": {
          const object = await importDwgOrDxf(file);
          if (!object) throw new ImportValidationError("DWG/DXF loader tidak menghasilkan object.");
          markSelectableRoot(object, { entityType: "dxf" });
          root = object;
          stats = this.getImportObjectStats(root);
          this.assertHasRenderableGeometry(stats, file);
          this.scene.add(object);
          imported = true;
          break;
        }
        default:
          throw new ImportValidationError(`Unsupported file format: ${extension}`);
      }

      if (imported) {
        this.clearPendingImport();
        const finalRoot = root ?? new THREE.Group();
        const finalStats = stats ?? this.getImportObjectStats(finalRoot);
        const message =
          extension === "ifc" && ifcItemsWithGeometry !== null
            ? `Import berhasil: ${file.name} (IFC items with geometry: ${ifcItemsWithGeometry})`
            : `Import berhasil: ${file.name} (mesh: ${finalStats.meshCount}, tris: ${finalStats.triangleCount})`;
        console.info(message);
        return { ok: true, file, extension, root: finalRoot, stats: finalStats, message };
      }

      const message = `Import gagal: ${file.name}`;
      return { ok: false, file, extension, message, error: new Error(message) };
    } catch (error) {
      const err = toError(error);
      const message = `Import gagal: ${file.name}. ${err.message}`;
      console.error(message, err);
      return { ok: false, file, extension: extension ?? null, message, error: err };
    }
  }

  public setupExport(buttonElement: HTMLElement, format: ExportFormat) {
    buttonElement.addEventListener("click", async () => {
      await this.export(format);
    });
  }

  public async export(format: ExportFormat) {
    console.log(`Exporting ${format}...`);
    switch (format) {
      case "glb": {
        const blob = await exportGlb(this.scene);
        this.downloadFile(blob, "scene.glb");
        break;
      }
      case "obj": {
        const blob = exportObj(this.scene);
        this.downloadFile(blob, "scene.obj");
        break;
      }
      case "ifc": {
        console.warn("IFC export is not supported directly from the scene graph.");
        break;
      }
      case "frag": {
        await this.exportLastIfcAsFragments();
        break;
      }
      case "schema": {
        await this.exportLastIfcSchema();
        break;
      }
    }
  }

  private getFileBaseName(filename: string) {
    const name = filename.split(/[\\/]/).pop() ?? filename;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return name;
    return name.slice(0, dot);
  }

  private getLastIfcModel(): FRAGS.FragmentsModel | null {
    if (this.lastIfcModel) return this.lastIfcModel;

    let found: FRAGS.FragmentsModel | null = null;
    this.scene.traverse((obj: any) => {
      if (found) return;
      const model = obj?.userData?.__fragmentsModel as FRAGS.FragmentsModel | undefined;
      if (model && typeof (model as any).getBuffer === "function") found = model;
    });
    return found;
  }

  private async exportLastIfcAsFragments() {
    const model = this.getLastIfcModel();
    if (!model) {
      console.warn("Tidak ada model IFC (Fragments) yang bisa diexport. Import IFC dulu.");
      return;
    }

    const buffer = await model.getBuffer(true);
    const name = this.lastIfcFileBaseName ? `${this.lastIfcFileBaseName}.frag` : "model.frag";
    this.downloadFile(new Blob([buffer]), name);
  }

  private async exportLastIfcSchema() {
    const model = this.getLastIfcModel();
    if (!model) {
      console.warn("Tidak ada model IFC (Fragments) untuk ekstrak schema. Import IFC dulu.");
      return;
    }

    const buffer = await model.getBuffer(true);
    const bytes = new Uint8Array(buffer);
    const bb = new flatbuffers.ByteBuffer(bytes);
    const readModel = FRAGS.Model.getRootAsModel(bb);

    const result: Record<string, any> = {};
    FRAGS.getObject(readModel, result);

    const name = this.lastIfcFileBaseName ? `${this.lastIfcFileBaseName}.schema.json` : "model.schema.json";
    this.downloadFile(new Blob([JSON.stringify(result)], { type: "application/json" }), name);
  }

  private async ensureIfcReady() {
    if (!this.ifc) {
      if (!this.components) {
        throw new Error("IFC import requires OBC.Components. Pass it to FileController constructor.");
      }
      this.ifc = new IfcManager(this.components);
    }

    if (!this.ifcSetupPromise) {
      this.ifcSetupPromise = this.ifc.setup();
    }

    await this.ifcSetupPromise;
  }

  private getActiveWorldCamera():
    | THREE.PerspectiveCamera
    | THREE.OrthographicCamera
    | null {
    if (!this.components) return null;
    const worlds = this.components.get(OBC.Worlds);
    for (const [, world] of worlds.list) {
      const camera = (world.camera as any)?.three as
        | THREE.PerspectiveCamera
        | THREE.OrthographicCamera
        | undefined;
      if (!camera) continue;
      if ((camera as any).isPerspectiveCamera || (camera as any).isOrthographicCamera) return camera;
    }
    return null;
  }

  private bindFragmentsModelToActiveCamera(model: { useCamera: (camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) => void }) {
    const camera = this.getActiveWorldCamera();
    if (!camera) return;
    try {
      model.useCamera(camera);
    } catch (e) {
      console.warn("Failed to bind FragmentsModel to active camera:", e);
    }
  }

  private async assertIfcHasGeometry(model: { getItemsIdsWithGeometry: () => Promise<number[]> }, file: File) {
    const ids = await model.getItemsIdsWithGeometry();
    if (ids.length === 0) {
      throw new ImportValidationError(
        `File '${file.name}' terbaca, tapi IFC tidak punya item dengan geometry. ` +
          `Kemungkinan: file hanya berisi metadata, atau schema/representasi IFC tidak didukung.`
      );
    }
    return ids.length;
  }

  private getIfcImportStats(
    model: { box: THREE.Box3 },
    root: THREE.Object3D
  ): ImportObjectStats {
    // Fragments models can start with zero rendered meshes (tiles load on-demand),
    // so rely on the model's bounding box instead of traversing the scene graph.
    const stats = this.getImportObjectStats(root);

    const box = model.box;
    const isFiniteBox = (b: THREE.Box3) =>
      Number.isFinite(b.min.x) &&
      Number.isFinite(b.min.y) &&
      Number.isFinite(b.min.z) &&
      Number.isFinite(b.max.x) &&
      Number.isFinite(b.max.y) &&
      Number.isFinite(b.max.z);

    if (!box.isEmpty() && isFiniteBox(box)) {
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);
      stats.bounds = { center, size };
    }

    return stats;
  }

  private getImportObjectStats(root: THREE.Object3D): ImportObjectStats {
    const stats: ImportObjectStats = {
      meshCount: 0,
      lineCount: 0,
      pointsCount: 0,
      vertexCount: 0,
      triangleCount: 0,
      bounds: null,
    };

    root.traverse((child: any) => {
      if (child?.isMesh) {
        stats.meshCount += 1;
        const geom = child.geometry as THREE.BufferGeometry | undefined;
        const pos = geom?.getAttribute?.("position") as THREE.BufferAttribute | undefined;
        const idx = geom?.getIndex?.() as THREE.BufferAttribute | null | undefined;
        if (pos) {
          stats.vertexCount += pos.count;
          if (idx) stats.triangleCount += Math.floor(idx.count / 3);
          else stats.triangleCount += Math.floor(pos.count / 3);
        }
        return;
      }
      if (child?.isLine || child?.isLineSegments) stats.lineCount += 1;
      if (child?.isPoints) stats.pointsCount += 1;
    });

    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const isFiniteBox = (b: THREE.Box3) =>
      Number.isFinite(b.min.x) &&
      Number.isFinite(b.min.y) &&
      Number.isFinite(b.min.z) &&
      Number.isFinite(b.max.x) &&
      Number.isFinite(b.max.y) &&
      Number.isFinite(b.max.z);

    if (!box.isEmpty() && isFiniteBox(box)) {
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);
      stats.bounds = { center, size };
    }

    return stats;
  }

  private assertHasRenderableGeometry(stats: ImportObjectStats, file: File) {
    const renderableCount = stats.meshCount + stats.lineCount + stats.pointsCount;
    if (renderableCount <= 0 || !stats.bounds) {
      throw new ImportValidationError(
        `File '${file.name}' terbaca, tapi tidak ditemukan geometry (mesh/line/points). ` +
          `Ini biasanya terjadi jika file kosong / tidak punya mesh, atau untuk .gltf yang butuh file pendamping (.bin/texture).`
      );
    }
  }

  private downloadFile(blob: Blob, filename: string) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }
}

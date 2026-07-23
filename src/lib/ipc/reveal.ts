import { revealItemInDir } from "@tauri-apps/plugin-opener";

export async function revealInFinder(path: string): Promise<void> {
  await revealItemInDir(path);
}

/**
 * Typed wrappers around window.electronAPI for convenience.
 */

export const ipc = {
  getPlatform: () => window.electronAPI.getPlatform(),
  minimize: () => window.electronAPI.minimize(),
  maximize: () => window.electronAPI.maximize(),
  close: () => window.electronAPI.close(),
  clearSession: () => window.electronAPI.clearSession(),
  oauth: (provider: string) => window.electronAPI.oauth(provider),
  openFileDialog: (options?: Electron.OpenDialogOptions) =>
    window.electronAPI.openFileDialog(options),
  saveFileDialog: (options?: Electron.SaveDialogOptions) =>
    window.electronAPI.saveFileDialog(options),
  showNotification: (opts: { title: string; body: string }) =>
    window.electronAPI.showNotification(opts),
  onNavigate: (callback: (path: string) => void) =>
    window.electronAPI.onNavigate(callback),
};

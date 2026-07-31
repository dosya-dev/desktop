/**
 * macOS Quick Action (Services menu) integration.
 *
 * Installs an Automator workflow to ~/Library/Services/ so that
 * "Sync with Dosya" appears when right-clicking files/folders in Finder
 * (under Quick Actions or Services). The workflow opens a dosya:// URL
 * which the Electron app handles via the open-url event.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { execFile } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { isMasBuild } from "./mas";

const WORKFLOW_NAME = "Sync with Dosya.workflow";
// v2: added the required Contents/Info.plist (NSServices). v1 installs shipped
// only document.wflow, so macOS never registered the Quick Action - bumping the
// version forces those broken installs to be reinstalled with the plist.
const WORKFLOW_VERSION = "2";

export function installQuickAction(): void {
  if (process.platform !== "darwin") return;
  // App Sandbox forbids writing to ~/Library/Services and forbids the
  // child_process call that registers the workflow. Store builds ship
  // without the Finder Quick Action.
  if (isMasBuild()) return;

  const servicesDir = join(homedir(), "Library", "Services");
  const workflowDir = join(servicesDir, WORKFLOW_NAME);
  const contentsDir = join(workflowDir, "Contents");
  const versionFile = join(contentsDir, ".dosya-version");

  // Skip if already installed with current version
  if (existsSync(versionFile)) {
    try {
      if (readFileSync(versionFile, "utf8").trim() === WORKFLOW_VERSION) return;
    } catch {}
  }

  // Remove old version if exists
  if (existsSync(workflowDir)) {
    rmSync(workflowDir, { recursive: true, force: true });
  }

  try {
    mkdirSync(contentsDir, { recursive: true });
    writeFileSync(join(contentsDir, "document.wflow"), buildWorkflowPlist());
    // Contents/Info.plist with an NSServices dict is REQUIRED for macOS (pbs) to
    // register the workflow in the Services / Quick Actions menu. Without it the
    // bundle is inert and never appears in Finder.
    writeFileSync(join(contentsDir, "Info.plist"), buildInfoPlist());
    writeFileSync(versionFile, WORKFLOW_VERSION);
    // Refresh the Services registry so the action appears without a re-login
    // (best-effort - pbs may not exist / may fail silently on some setups).
    execFile("/System/Library/CoreServices/pbs", ["-update"], () => {});
    console.log("[services] Installed Quick Action: Sync with Dosya");
  } catch (err) {
    console.error("[services] Failed to install Quick Action:", err);
  }
}

/** Info.plist declaring the workflow as a Finder Services / Quick Action item. */
function buildInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Sync with Dosya</string>
	<key>CFBundleIdentifier</key>
	<string>dev.dosya.quickaction.syncwithdosya</string>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>Sync with Dosya</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.item</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`;
}

export function uninstallQuickAction(): void {
  if (process.platform !== "darwin") return;
  if (isMasBuild()) return; // never installed one, nothing to remove

  const workflowDir = join(homedir(), "Library", "Services", WORKFLOW_NAME);
  if (existsSync(workflowDir)) {
    rmSync(workflowDir, { recursive: true, force: true });
  }
}

function buildWorkflowPlist(): string {
  // Shell script: percent-encode the selected path using perl (always available on macOS)
  // and open the dosya:// URL which the Electron app handles.
  // inputMethod=1 means "as arguments" so each selected item is passed as $1, $2, etc.
  const shellScript =
    `for f in "$@"; do\n` +
    `    encoded=$(printf '%s' "$f" | perl -pe 's/([^A-Za-z0-9\\-._~])/sprintf("%%%02X",ord($1))/ge')\n` +
    `    open "dosya://sync?path=$encoded"\n` +
    `done`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>521.1</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<false/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.path</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>1.0.2</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMBundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>AMCategory</key>
				<string>AMCategoryUtilities</string>
				<key>AMIconName</key>
				<string>TerminalAction</string>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.path</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>${shellScript}</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/bash</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>1.0.2</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>A1B2C3D4-E5F6-7890-ABCD-EF1234567890</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>B2C3D4E5-F6A7-8901-BCDE-F12345678901</string>
				<key>UUID</key>
				<string>C3D4E5F6-A7B8-9012-CDEF-123456789012</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>529.000000:718.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>`;
}

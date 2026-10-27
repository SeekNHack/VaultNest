import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class CaptureUnavailableError extends Error {}

const TIMEOUT_MS = 20_000;
const MAX_DISPLAYS = 8;

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, env: env ?? process.env }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Windows: capture the whole virtual desktop (all monitors) with built-in .NET, DPI-aware. */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace PV -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][PV.Dpi]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($env:PV_CAPTURE_FILE, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;

/** Linux tools tried in order; each writes a PNG of the full screen to the given file. */
function linuxTools(file: string): { cmd: string; args: string[] }[] {
  const wayland = !!process.env.WAYLAND_DISPLAY;
  const tools = [
    { cmd: 'gnome-screenshot', args: ['-f', file] },
    { cmd: 'spectacle', args: ['-b', '-n', '-f', '-o', file] },
    { cmd: 'grim', args: [file] },
    { cmd: 'import', args: ['-window', 'root', file] }, // ImageMagick (X11)
    { cmd: 'scrot', args: ['-o', file] },
    { cmd: 'maim', args: [file] },
    { cmd: 'xfce4-screenshooter', args: ['-f', '-s', file] },
  ];
  // Prefer native Wayland tools first on Wayland sessions, X11 tools first otherwise.
  return wayland ? tools : [tools[3], tools[4], tools[5], tools[0], tools[1], tools[6], tools[2]];
}

/**
 * Takes a screenshot of every display using the operating system's own tools
 * (no extra installation on macOS and Windows) and returns the PNG bytes.
 * Temporary files are written to a private directory and deleted immediately.
 */
export async function captureScreens(): Promise<Uint8Array[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-capture-'));
  try {
    await fs.chmod(dir, 0o700).catch(() => undefined);
    const files: string[] = [];
    if (process.platform === 'darwin') {
      for (let i = 0; i < MAX_DISPLAYS; i++) files.push(path.join(dir, `display-${i}.png`));
      await run('/usr/sbin/screencapture', ['-x', '-t', 'png', ...files]); // one file per display
    } else if (process.platform === 'win32') {
      const file = path.join(dir, 'screen.png');
      files.push(file);
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT], { ...process.env, PV_CAPTURE_FILE: file });
    } else {
      const file = path.join(dir, 'screen.png');
      files.push(file);
      let captured = false;
      for (const tool of linuxTools(file)) {
        try {
          await run(tool.cmd, tool.args);
          captured = await fs.stat(file).then((s) => s.size > 0, () => false);
          if (captured) break;
        } catch {
          // not installed, or failed (e.g. an X11 tool on Wayland): try the next one
        }
      }
      if (!captured) {
        throw new CaptureUnavailableError('No screenshot tool was found (tried gnome-screenshot, spectacle, grim, ImageMagick import, scrot, maim). Use your desktop\'s screenshot shortcut to copy the QR code, then paste it into the 2FA field of the dashboard.');
      }
    }
    const images: Uint8Array[] = [];
    for (const f of files) {
      try {
        images.push(new Uint8Array(await fs.readFile(f)));
      } catch {
        // fewer displays than file slots (macOS)
      }
    }
    if (!images.length) throw new Error('The screenshot could not be taken.');
    return images;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

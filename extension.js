const vscode = require('vscode');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const cp     = require('child_process');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NEXA_REPO   = 'https://github.com/IoNiCx1/nexa';
const RUNTIME_LIB = 'nexa_runtime.a';   // sits next to the nexa binary

// ─────────────────────────────────────────────────────────────────────────────
// Platform helpers
// ─────────────────────────────────────────────────────────────────────────────

function getPlatformInfo() {
    const p = os.platform();
    if (p === 'win32')  return { folder: 'windows', binary: 'nexa.exe', shell: true  };
    if (p === 'linux')  return { folder: 'linux',   binary: 'nexa',     shell: false };
    if (p === 'darwin') return { folder: 'mac',     binary: 'nexa',     shell: false };
    return null;
}

function getCompilerPath(context) {
    const info = getPlatformInfo();
    if (!info) return null;
    return path.join(context.extensionPath, 'bin', info.folder, info.binary);
}

function getRuntimePath(compilerPath) {
    return path.join(path.dirname(compilerPath), RUNTIME_LIB);
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary existence check + permission fix (Linux/macOS)
// ─────────────────────────────────────────────────────────────────────────────

function ensureExecutable(filePath) {
    if (os.platform() === 'win32') return true;
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        try {
            fs.chmodSync(filePath, 0o755);
            return true;
        } catch (e) {
            return false;
        }
    }
}

function checkBinaries(compilerPath) {
    if (!fs.existsSync(compilerPath)) return { ok: false, reason: `Compiler not found:\n${compilerPath}` };
    const runtimePath = getRuntimePath(compilerPath);
    if (!fs.existsSync(runtimePath)) return { ok: false, reason: `Runtime not found:\n${runtimePath}` };
    if (!ensureExecutable(compilerPath)) return { ok: false, reason: `Cannot make compiler executable:\n${compilerPath}` };
    return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save document before running
// ─────────────────────────────────────────────────────────────────────────────

async function saveIfDirty(document) {
    if (document.isDirty) {
        await document.save();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get or reuse a named terminal — forces PowerShell on Windows
// ─────────────────────────────────────────────────────────────────────────────

function getTerminal(name, reuse) {
    const existing = vscode.window.terminals.find(t => t.name === name);
    if (reuse && existing) return existing;
    if (existing) existing.dispose();

    // Windows: explicitly use PowerShell so & operator and quoted paths work
    if (os.platform() === 'win32') {
        return vscode.window.createTerminal({
            name,
            shellPath: 'powershell.exe',
            shellArgs: ['-NoLogo']
        });
    }
    return vscode.window.createTerminal(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote a path safely for the shell
// ─────────────────────────────────────────────────────────────────────────────

function q(p) {
    // Windows: use double quotes; Unix: use single quotes to handle spaces
    if (os.platform() === 'win32') return `"${p}"`;
    return `'${p.replace(/'/g, "'\\''")}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the run command for the current platform
// ─────────────────────────────────────────────────────────────────────────────

function buildRunCommand(compilerPath, filePath) {
    if (os.platform() === 'win32') {
        // PowerShell requires & operator to invoke executables stored in variables
        // and each argument must be a separate quoted string
        return `& ${q(compilerPath)} ${q(filePath)}`;
    }
    // Linux / macOS
    return `${q(compilerPath)} ${q(filePath)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nexa version reader — reads version from binary --version flag if available,
// falls back to the extension's package.json version
// ─────────────────────────────────────────────────────────────────────────────

function getNexaVersion(compilerPath, context) {
    try {
        const out = cp.execFileSync(compilerPath, ['--version'], { timeout: 2000 }).toString().trim();
        if (out) return out;
    } catch { /* binary doesn't support --version yet */ }
    return `extension v${context.extension.packageJSON.version}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar item
// ─────────────────────────────────────────────────────────────────────────────

let statusBarItem;

function updateStatusBar(show) {
    if (!statusBarItem) return;
    if (show) {
        statusBarItem.show();
    } else {
        statusBarItem.hide();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main command: run the current .nx file
// ─────────────────────────────────────────────────────────────────────────────

async function runNexaFile(context) {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showErrorMessage('RunX: No active file open.');
        return;
    }

    if (editor.document.languageId !== 'nexa') {
        vscode.window.showErrorMessage('RunX: Active file is not a Nexa (.nx) file.');
        return;
    }

    // Save before running so the compiler sees the latest version
    await saveIfDirty(editor.document);

    const compilerPath = getCompilerPath(context);

    if (!compilerPath) {
        vscode.window.showErrorMessage(`RunX: Unsupported OS (${os.platform()}). Please open an issue at ${NEXA_REPO}.`);
        return;
    }

    const check = checkBinaries(compilerPath);
    if (!check.ok) {
        const action = await vscode.window.showErrorMessage(
            `RunX: ${check.reason}`,
            'Open Extension Folder'
        );
        if (action === 'Open Extension Folder') {
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(context.extensionPath));
        }
        return;
    }

    const filePath = editor.document.fileName;
    const cmd      = buildRunCommand(compilerPath, filePath);
    const config   = vscode.workspace.getConfiguration('runx');
    const reuse    = config.get('reuseTerminal', false);
    const terminal = getTerminal('RunX — Nexa', reuse);

    terminal.show(true);   // true = don't steal focus

    // Print a small header so the user knows what's running
    const fileName = path.basename(filePath);
    if (os.platform() === 'win32') {
        terminal.sendText(`Write-Host "── RunX ──────────────────────────────" -ForegroundColor Cyan`);
        terminal.sendText(`Write-Host "  File: ${fileName}" -ForegroundColor Cyan`);
        terminal.sendText(`Write-Host "──────────────────────────────────────" -ForegroundColor Cyan`);
    } else {
        terminal.sendText(`echo "\\033[36m── RunX ──────────────────────────────\\033[0m"`);
        terminal.sendText(`echo "\\033[36m  File: ${fileName}\\033[0m"`);
        terminal.sendText(`echo "\\033[36m──────────────────────────────────────\\033[0m"`);
    }

    terminal.sendText(cmd);
}

// ─────────────────────────────────────────────────────────────────────────────
// Activate
// ─────────────────────────────────────────────────────────────────────────────

function activate(context) {

    // ── Status bar button ─────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left, 100
    );
    statusBarItem.command = 'runx.runFile';
    statusBarItem.text    = '$(play) Run Nexa';
    statusBarItem.tooltip = 'Run current .nx file with RunX';
    context.subscriptions.push(statusBarItem);

    // Show status bar item only when a .nx file is active
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            updateStatusBar(editor && editor.document.languageId === 'nexa');
        })
    );

    // Handle the case where a .nx file is already open on activation
    updateStatusBar(
        vscode.window.activeTextEditor &&
        vscode.window.activeTextEditor.document.languageId === 'nexa'
    );

    // ── Run command ───────────────────────────────────────────────────────────
    const runCmd = vscode.commands.registerCommand(
        'runx.runFile',
        () => runNexaFile(context)
    );
    context.subscriptions.push(runCmd);

    // ── Diagnostics on open / save ────────────────────────────────────────────
    // Warn user if the binary is missing when they open a .nx file
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.languageId !== 'nexa') return;
            const compilerPath = getCompilerPath(context);
            if (!compilerPath) return;
            const check = checkBinaries(compilerPath);
            if (!check.ok) {
                vscode.window.showWarningMessage(
                    `RunX: Nexa compiler not found for ${os.platform()}. ` +
                    `Place the binary in bin/${getPlatformInfo()?.folder ?? 'your-os'}/`
                );
            }
        })
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Deactivate
// ─────────────────────────────────────────────────────────────────────────────

function deactivate() {
    if (statusBarItem) statusBarItem.dispose();
}

module.exports = { activate, deactivate };

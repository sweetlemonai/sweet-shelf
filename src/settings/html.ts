import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/**
 * Build the webview HTML for the Sweet Shelf Settings panel.
 *
 * Self-contained: a single HTML string with inline `<style>` and a
 * single `<script nonce="…">` block. No external scripts, no fetch,
 * no eval. CSP locks `script-src` to the per-render nonce, `img-src`
 * to the webview's resource source, and `style-src` to inline +
 * resource source so VS Code theme variables can be referenced from
 * the inline stylesheet.
 *
 * The webview opens "blank" — the script's first action on load is to
 * post a `ready` message; the extension responds with `state` and the
 * script paints the form values + app cards. State updates work the
 * same way: every change refreshes the whole DOM rather than diffing.
 * Tiny page; trivially fast.
 */
export function renderSettingsHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Sweet Shelf Settings</title>
  <style>${SETTINGS_CSS}</style>
</head>
<body>
  <main>
    <header>
      <h1>Sweet Shelf Settings</h1>
      <p class="subtitle">A workspace map for VS Code.</p>
    </header>

    <section id="preferences">
      <h2>Preferences</h2>

      <div class="setting" data-radio-group="defaultFolderClickAction">
        <label class="setting-label">Default folder click action</label>
        <div class="radio-group">
          <label><input type="radio" name="defaultFolderClickAction" value="browse" /> Browse inline (recommended)</label>
          <label><input type="radio" name="defaultFolderClickAction" value="openInCurrentWindow" /> Open in current window</label>
          <label><input type="radio" name="defaultFolderClickAction" value="openInNewWindow" /> Open in new window</label>
        </div>
      </div>

      <div class="setting" data-radio-group="defaultFileClickAction">
        <label class="setting-label">Default file click action</label>
        <div class="radio-group">
          <label><input type="radio" name="defaultFileClickAction" value="open" /> Open</label>
          <label><input type="radio" name="defaultFileClickAction" value="openToSide" /> Open to side</label>
        </div>
      </div>

      <div class="setting">
        <label class="setting-label" for="maxRecentItems">Maximum recent items</label>
        <input
          id="maxRecentItems"
          type="number"
          min="1"
          max="100"
          step="1"
          data-setting-key="maxRecentItems"
        />
      </div>

      <div class="setting checkbox">
        <label>
          <input type="checkbox" data-setting-key="showFileExtensions" />
          Show file extensions in labels
        </label>
      </div>

      <div class="setting checkbox">
        <label>
          <input type="checkbox" data-setting-key="showHiddenFiles" />
          Show hidden files when browsing folders
        </label>
      </div>

      <div class="setting checkbox">
        <label>
          <input type="checkbox" data-setting-key="confirmRemoveCategory" />
          Confirm before removing non-empty categories
        </label>
      </div>

      <p class="footnote">
        All Sweet Shelf settings are also available in VS Code's Settings
        (<kbd>Cmd</kbd>+<kbd>,</kbd> on macOS, <kbd>Ctrl</kbd>+<kbd>,</kbd> on Windows / Linux).
      </p>
    </section>

    <section id="apps">
      <h2>Sweet Lemon Apps</h2>
      <p class="subtitle">Companion extensions for your shelf.</p>
      <div id="app-list"></div>
      <p class="more"><a href="#" id="open-more">More from Sweet Lemon →</a></p>
    </section>
  </main>

  <script nonce="${nonce}">${SETTINGS_SCRIPT}</script>
</body>
</html>`;
}

/**
 * VS Code theme-variable–driven stylesheet. Single column, max 720px,
 * generous whitespace. Every color is a `--vscode-*` variable so the
 * page adapts to light/dark/contrast themes without us shipping
 * palettes.
 */
const SETTINGS_CSS = `
:root {
  --gap: 1.25rem;
  --card-pad: 1rem;
}

* { box-sizing: border-box; }

body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 2rem 1.5rem 4rem;
  line-height: 1.5;
}

main {
  max-width: 720px;
  margin: 0 auto;
}

header {
  margin-bottom: 2.5rem;
  border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
  padding-bottom: 1.25rem;
}

h1 {
  margin: 0 0 0.25rem;
  font-size: 1.5rem;
  font-weight: 600;
}

h2 {
  margin: 0 0 0.25rem;
  font-size: 1.15rem;
  font-weight: 600;
}

.subtitle {
  margin: 0 0 1.5rem;
  color: var(--vscode-descriptionForeground);
}

section {
  margin-bottom: 3rem;
}

.setting {
  margin-bottom: var(--gap);
}

.setting-label {
  display: block;
  font-weight: 500;
  margin-bottom: 0.4rem;
}

.radio-group label,
.checkbox label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0;
  cursor: pointer;
}

.radio-group input[type="radio"],
.checkbox input[type="checkbox"] {
  accent-color: var(--vscode-button-background);
  width: 1rem;
  height: 1rem;
}

input[type="number"] {
  width: 6rem;
  padding: 0.35rem 0.5rem;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
  border-radius: 2px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

input[type="number"]:focus {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.footnote {
  margin-top: 2rem;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

kbd {
  background: var(--vscode-keybindingLabel-background);
  color: var(--vscode-keybindingLabel-foreground);
  border: 1px solid var(--vscode-keybindingLabel-border, transparent);
  border-bottom-width: 2px;
  border-radius: 3px;
  padding: 1px 5px;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.85em;
}

.app-card {
  display: flex;
  gap: 1rem;
  padding: var(--card-pad);
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
  border-radius: 4px;
  margin-bottom: 0.75rem;
  background: var(--vscode-editor-background);
}

.app-card:hover {
  border-color: var(--vscode-focusBorder);
}

.app-icon {
  width: 56px;
  height: 56px;
  flex: 0 0 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: var(--vscode-input-background);
  color: var(--vscode-descriptionForeground);
  font-size: 1.5rem;
}

.app-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 4px;
}

.app-body {
  flex: 1;
  min-width: 0;
}

.app-name {
  font-weight: 600;
  margin: 0 0 0.25rem;
}

.app-desc {
  margin: 0 0 0.75rem;
  color: var(--vscode-descriptionForeground);
}

.app-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.app-actions button {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  padding: 0.35rem 0.85rem;
  border: 1px solid transparent;
  border-radius: 2px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
}

.app-actions button:hover {
  background: var(--vscode-button-hoverBackground);
}

.app-actions button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.app-actions button.secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.app-actions .installed-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85em;
  color: var(--vscode-charts-green);
}

.more {
  margin-top: 1.5rem;
}

.more a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}

.more a:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}
`;

/**
 * Tiny vanilla script. On load posts `ready`, then handles `state`
 * messages by repainting the form + app cards. Every form change
 * posts an `updateSetting`; every app card button posts the
 * appropriate action message.
 */
const SETTINGS_SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();

  function applySettingsState(state) {
    document.querySelectorAll('[data-setting-key]').forEach((el) => {
      const key = el.dataset.settingKey;
      const value = state[key];
      if (value === undefined) return;
      if (el.type === 'checkbox') el.checked = !!value;
      else if (el.type === 'number') el.value = String(value);
      else el.value = String(value);
    });
    document.querySelectorAll('[data-radio-group]').forEach((wrapper) => {
      const key = wrapper.dataset.radioGroup;
      const value = state[key];
      wrapper.querySelectorAll('input[type="radio"]').forEach((radio) => {
        radio.checked = radio.value === value;
      });
    });
  }

  function renderApps(apps) {
    const list = document.getElementById('app-list');
    list.innerHTML = '';
    apps.forEach((app) => {
      const card = document.createElement('div');
      card.className = 'app-card';

      const icon = document.createElement('div');
      icon.className = 'app-icon';
      if (app.iconWebviewUri) {
        const img = document.createElement('img');
        img.src = app.iconWebviewUri;
        img.alt = '';
        img.onerror = () => {
          icon.removeChild(img);
          icon.textContent = '✦';
        };
        icon.appendChild(img);
      } else {
        icon.textContent = '✦';
      }

      const body = document.createElement('div');
      body.className = 'app-body';

      const name = document.createElement('p');
      name.className = 'app-name';
      name.textContent = app.displayName;

      const desc = document.createElement('p');
      desc.className = 'app-desc';
      desc.textContent = app.description;

      const actions = document.createElement('div');
      actions.className = 'app-actions';

      if (app.installed) {
        const pill = document.createElement('span');
        pill.className = 'installed-pill';
        pill.textContent = '✓ Installed';
        actions.appendChild(pill);

        const openBtn = document.createElement('button');
        openBtn.className = 'secondary';
        openBtn.textContent = 'Open';
        openBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'openApp', extensionId: app.extensionId });
        });
        actions.appendChild(openBtn);
      } else {
        const installBtn = document.createElement('button');
        installBtn.textContent = 'Install';
        installBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'installApp', extensionId: app.extensionId });
        });
        actions.appendChild(installBtn);
      }

      body.appendChild(name);
      body.appendChild(desc);
      body.appendChild(actions);
      card.appendChild(icon);
      card.appendChild(body);
      list.appendChild(card);
    });
  }

  document.querySelectorAll('input[data-setting-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.settingKey;
      let value;
      if (input.type === 'checkbox') {
        value = input.checked;
      } else if (input.type === 'number') {
        const n = Number(input.value);
        if (!Number.isFinite(n)) return;
        value = Math.max(1, Math.min(100, Math.floor(n)));
        if (value !== n) input.value = String(value);
      } else {
        value = input.value;
      }
      vscode.postMessage({ type: 'updateSetting', key, value });
    });
  });

  document.querySelectorAll('[data-radio-group]').forEach((wrapper) => {
    const key = wrapper.dataset.radioGroup;
    wrapper.querySelectorAll('input[type="radio"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        vscode.postMessage({ type: 'updateSetting', key, value: radio.value });
      });
    });
  });

  document.getElementById('open-more').addEventListener('click', (ev) => {
    ev.preventDefault();
    vscode.postMessage({ type: 'openMore' });
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'state') return;
    applySettingsState(msg.settings);
    renderApps(msg.apps);
  });

  vscode.postMessage({ type: 'ready' });
})();
`;

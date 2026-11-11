import { useRef, useState } from 'react';
import { FileCode2, FileSpreadsheet, FileText, Folder, FolderOpen, ChevronRight, ChevronsDownUp, Layers, Plus, Upload, NotebookText, FileDatabase, FileBraces, FileImage } from 'lucide-react';
import IconButton from './IconButton.jsx';
import { typeOf } from '../lib/fileTypes.js';

const CODE = new Set(['python', 'javascript', 'typescript', 'shell', 'r', 'java', 'c', 'cpp', 'html', 'css', 'sql']);
const iconFor = (path) => {
  const type = typeOf(path)?.id;
  if (type === 'notebook') return NotebookText;
  if (type === 'database') return FileDatabase;
  if (type === 'csv') return FileSpreadsheet;
  if (type === 'json' || type === 'yaml' || type === 'toml' || type === 'xml') return FileBraces;
  if (CODE.has(type)) return FileCode2;
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(path)) return FileImage;
  return FileText;
};

// Builds a one-level tree: top-level files, then folders with their files.
function buildTree(paths) {
  const root = [];
  const folders = new Map();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts.length === 1) root.push({ type: 'file', path, name: path });
    else {
      const folder = parts[0];
      if (!folders.has(folder)) {
        folders.set(folder, { type: 'folder', name: folder, children: [] });
        root.push(folders.get(folder));
      }
      folders.get(folder).children.push({ type: 'file', path, name: parts.slice(1).join('/') });
    }
  }
  return root;
}

// Every row has the same columns: disclosure arrow (empty for files), icon,
// name. Depth only moves the row right, so icons and names line up.
function FileRow({ node, depth, active, onOpen }) {
  const Icon = iconFor(node.path);
  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-selected={active}
        aria-level={depth + 1}
        className={`file-row ${active ? 'is-active' : ''}`}
        style={{ '--depth': depth }}
        onClick={() => onOpen(node.path)}
      >
        <span className="file-twisty" aria-hidden="true" />
        <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="file-icon" />
        <span className="file-name">{node.name}</span>
      </button>
    </li>
  );
}

// Up/Down move between visible rows, Left/Right close/open folders,
// Home/End jump to the ends. Tab still reaches every row.
function handleTreeKeys(e, setCollapsed) {
  const rows = [...e.currentTarget.querySelectorAll('[role="treeitem"]')];
  const index = rows.indexOf(document.activeElement);
  if (index === -1) return;
  const row = rows[index];
  const focus = (i) => rows[Math.max(0, Math.min(rows.length - 1, i))]?.focus();
  const folder = row.dataset.folder;
  switch (e.key) {
    case 'ArrowDown':
      focus(index + 1);
      break;
    case 'ArrowUp':
      focus(index - 1);
      break;
    case 'Home':
      focus(0);
      break;
    case 'End':
      focus(rows.length - 1);
      break;
    case 'ArrowRight':
      if (folder && row.getAttribute('aria-expanded') === 'false') setCollapsed((c) => ({ ...c, [folder]: false }));
      else if (folder) focus(index + 1);
      else return;
      break;
    case 'ArrowLeft':
      if (folder && row.getAttribute('aria-expanded') === 'true') setCollapsed((c) => ({ ...c, [folder]: true }));
      else if (!folder && row.getAttribute('aria-level') === '2') {
        // Jump to the parent folder.
        const parent = rows.slice(0, index).findLast((r) => r.dataset.folder);
        parent?.focus();
      } else return;
      break;
    default:
      return;
  }
  e.preventDefault();
}

// Files dragged in from outside (Finder, Explorer, the iPad Files app).
const carriesFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

export default function FileSidebar({ paths, activePath, onOpen, projectName, runCount, onNewFile, onAddFiles }) {
  const [collapsed, setCollapsed] = useState({});
  const [dropping, setDropping] = useState(false);
  const picker = useRef(null);
  const dropProps = onAddFiles
    ? {
        onDragOver: (e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropping(true);
        },
        onDragLeave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false);
        },
        onDrop: (e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          setDropping(false);
          onAddFiles(e.dataTransfer.files);
        },
      }
    : {};
  const tree = buildTree(paths);
  const folders = tree.filter((n) => n.type === 'folder');
  const anyOpen = folders.some((f) => !collapsed[f.name]);

  return (
    <nav className={`sidebar-inner ${dropping ? 'is-drop-target' : ''}`} aria-label="Project files" {...dropProps}>
      <div className="panel-header">
        <span className="panel-title">Files</span>
        {folders.length > 0 && (
          <IconButton
            icon={ChevronsDownUp}
            label={anyOpen ? 'Collapse folders' : 'Expand folders'}
            className="icon-btn-sm panel-header-action push-right"
            onClick={() => setCollapsed(Object.fromEntries(folders.map((f) => [f.name, anyOpen])))}
          />
        )}
        {onAddFiles && (
          <>
            <IconButton
              icon={Upload}
              label="Add files…"
              className={`icon-btn-sm ${folders.length > 0 ? '' : 'push-right'}`}
              onClick={() => picker.current?.click()}
            />
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                onAddFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
        {onNewFile && (
          <IconButton
            icon={Plus}
            label="New file"
            className={`icon-btn-sm ${folders.length > 0 || onAddFiles ? '' : 'push-right'}`}
            onClick={onNewFile}
          />
        )}
      </div>
      {dropping && <div className="drop-hint" aria-hidden="true">Drop to add to {projectName}</div>}
      <ul className="file-tree" role="tree" aria-label="Files" onKeyDown={(e) => handleTreeKeys(e, setCollapsed)}>
        {tree.map((node) =>
          node.type === 'file' ? (
            <FileRow key={node.path} node={node} depth={0} active={node.path === activePath} onOpen={onOpen} />
          ) : (
            <li key={node.name} role="none">
              <button
                type="button"
                role="treeitem"
                aria-level={1}
                aria-expanded={!collapsed[node.name]}
                data-folder={node.name}
                className="file-row folder-row"
                style={{ '--depth': 0 }}
                onClick={() => setCollapsed((c) => ({ ...c, [node.name]: !c[node.name] }))}
              >
                <span className="file-twisty" aria-hidden="true">
                  <ChevronRight size={14} className={`folder-chevron ${collapsed[node.name] ? '' : 'is-open'}`} />
                </span>
                {collapsed[node.name] ? (
                  <Folder size={16} strokeWidth={1.75} aria-hidden="true" className="file-icon" />
                ) : (
                  <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" className="file-icon" />
                )}
                <span className="file-name">{node.name}</span>
              </button>
              {!collapsed[node.name] && (
                <ul role="group" className="file-group">
                  {node.children.map((child) => (
                    <FileRow key={child.path} node={child} depth={1} active={child.path === activePath} onOpen={onOpen} />
                  ))}
                </ul>
              )}
            </li>
          )
        )}
      </ul>
      <div className="sidebar-footer">
        <Layers size={16} aria-hidden="true" className="sidebar-footer-icon" />
        <div className="sidebar-footer-text">
          <span className="sidebar-footer-name">{projectName}</span>
          <span className="sidebar-footer-meta">
            {paths.length} files · {runCount === 0 ? 'no runs yet' : `${runCount} run${runCount === 1 ? '' : 's'}`}
          </span>
        </div>
      </div>
    </nav>
  );
}

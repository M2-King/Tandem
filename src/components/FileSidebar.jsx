import { useState } from 'react';
import { FileCode2, FileSpreadsheet, Folder, FolderOpen, ChevronRight } from 'lucide-react';

const iconFor = (path) => (path.endsWith('.csv') ? FileSpreadsheet : FileCode2);

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

function FileRow({ node, depth, active, onOpen }) {
  const Icon = iconFor(node.path);
  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-selected={active}
        className={`file-row ${active ? 'is-active' : ''}`}
        style={{ paddingLeft: 12 + depth * 18 }}
        onClick={() => onOpen(node.path)}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="file-icon" />
        <span className="file-name">{node.name}</span>
      </button>
    </li>
  );
}

export default function FileSidebar({ paths, activePath, onOpen }) {
  const [collapsed, setCollapsed] = useState({});
  const tree = buildTree(paths);

  return (
    <nav className="sidebar-inner" aria-label="Project files">
      <div className="panel-header">
        <span className="panel-title">Files</span>
      </div>
      <ul className="file-tree" role="tree" aria-label="Files">
        {tree.map((node) =>
          node.type === 'file' ? (
            <FileRow key={node.path} node={node} depth={0} active={node.path === activePath} onOpen={onOpen} />
          ) : (
            <li key={node.name} role="none">
              <button
                type="button"
                role="treeitem"
                aria-expanded={!collapsed[node.name]}
                className="file-row folder-row"
                onClick={() => setCollapsed((c) => ({ ...c, [node.name]: !c[node.name] }))}
              >
                <ChevronRight
                  size={16}
                  aria-hidden="true"
                  className={`folder-chevron ${collapsed[node.name] ? '' : 'is-open'}`}
                />
                {collapsed[node.name] ? (
                  <Folder size={16} strokeWidth={1.75} aria-hidden="true" className="file-icon" />
                ) : (
                  <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" className="file-icon" />
                )}
                <span className="file-name">{node.name}</span>
              </button>
              {!collapsed[node.name] && (
                <ul role="group">
                  {node.children.map((child) => (
                    <FileRow key={child.path} node={child} depth={1} active={child.path === activePath} onOpen={onOpen} />
                  ))}
                </ul>
              )}
            </li>
          )
        )}
      </ul>
    </nav>
  );
}

/**
 * Unified diff parser for Neurcode
 * Parses git unified diff format into structured objects
 */

export type ChangeType = 'add' | 'delete' | 'modify' | 'rename';

export interface DiffFile {
  path: string;
  oldPath?: string;
  changeType: ChangeType;
  addedLines: number;
  removedLines: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'added' | 'removed';
  content: string;
  lineNumber?: number;
}

/**
 * Parse a unified diff string into structured DiffFile objects
 */
export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diffText.split('\n');

  let currentFile: Partial<DiffFile> | null = null;
  let currentHunk: Partial<DiffHunk> | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // File header: diff --git a/path b/path
    if (line.startsWith('diff --git')) {
      // Save previous file if exists
      if (currentFile && currentHunk) {
        currentFile.hunks!.push(currentHunk as DiffHunk);
        files.push(currentFile as DiffFile);
      }

      // Parse file paths
      const match = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        const oldPath = match[1];
        const newPath = match[2];

        // Determine change type
        let changeType: ChangeType = 'modify';
        if (oldPath === '/dev/null' || oldPath === 'a') {
          changeType = 'add';
        } else if (newPath === '/dev/null' || newPath === 'b') {
          changeType = 'delete';
        } else if (oldPath !== newPath) {
          changeType = 'rename';
        }

        currentFile = {
          path: changeType === 'delete' ? oldPath : newPath,
          oldPath: oldPath !== newPath && changeType !== 'add' && changeType !== 'delete' ? oldPath : undefined,
          changeType,
          addedLines: 0,
          removedLines: 0,
          hunks: []
        };
        currentHunk = null;
      }
      i++;
      continue;
    }

    // Index line: index hash1..hash2 mode
    if (line.startsWith('index ')) {
      i++;
      continue;
    }

    // Old/new file mode: new file mode 100644 or deleted file mode
    if (line.match(/^new file mode/)) {
      if (currentFile) {
        currentFile.changeType = 'add';
      }
      i++;
      continue;
    }
    if (line.match(/^deleted file mode/)) {
      if (currentFile) {
        currentFile.changeType = 'delete';
      }
      i++;
      continue;
    }

    // Rename detection: rename from/to
    if (line.startsWith('rename from')) {
      i++;
      continue;
    }
    if (line.startsWith('rename to')) {
      i++;
      continue;
    }

    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    if (line.startsWith('@@')) {
      // Save previous hunk if exists
      if (currentHunk && currentFile) {
        currentFile.hunks!.push(currentHunk as DiffHunk);
      }

      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch && currentFile) {
        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldLines: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 0,
          newStart: parseInt(hunkMatch[3], 10),
          newLines: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 0,
          lines: []
        };
      }
      i++;
      continue;
    }

    // Diff content lines
    if (currentHunk && currentFile) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        // Added line
        currentHunk.lines!.push({
          type: 'added',
          content: line.substring(1)
        });
        currentFile.addedLines = (currentFile.addedLines || 0) + 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // Removed line
        currentHunk.lines!.push({
          type: 'removed',
          content: line.substring(1)
        });
        currentFile.removedLines = (currentFile.removedLines || 0) + 1;
      } else if (line.startsWith(' ')) {
        // Context line
        currentHunk.lines!.push({
          type: 'context',
          content: line.substring(1)
        });
      }
    }

    i++;
  }

  // Save last file and hunk
  if (currentHunk && currentFile) {
    currentFile.hunks!.push(currentHunk as DiffHunk);
  }
  if (currentFile) {
    files.push(currentFile as DiffFile);
  }

  return files;
}
/**
 * Get summary statistics from parsed diff files
 */
export interface DiffSummary {
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
  files: Array<{
    path: string;
    changeType: ChangeType;
    added: number;
    removed: number;
  }>;
}

export function getDiffSummary(files: DiffFile[]): DiffSummary {
  const totalAdded = files.reduce((sum, file) => sum + file.addedLines, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removedLines, 0);

  return {
    totalFiles: files.length,
    totalAdded,
    totalRemoved,
    files: files.map(file => ({
      path: file.path,
      changeType: file.changeType,
      added: file.addedLines,
      removed: file.removedLines
    }))
  };
}

import type { AnySandbox } from "@/types";

export interface BackgroundProcess {
  pid: number;
  command: string;
  outputFiles: string[];
  startTime: number;
}

export class BackgroundProcessTracker {
  private processes: Map<number, BackgroundProcess>;

  constructor() {
    this.processes = new Map();
  }

  /**
   * Add a background process to track
   */
  addProcess(pid: number, command: string, outputFiles: string[]): void {
    this.processes.set(pid, {
      pid,
      command,
      outputFiles,
      startTime: Date.now(),
    });
  }

  /**
   * Remove a completed process from tracking
   */
  removeProcess(pid: number): void {
    this.processes.delete(pid);
  }

  /**
   * Check if a process is still running
   */
  async checkProcessStatus(sandbox: AnySandbox, pid: number): Promise<boolean> {
    try {
      const result = await sandbox.commands.run(`ps -p ${pid}`, {});

      const isRunning = result.stdout.includes(pid.toString());

      if (!isRunning) {
        this.removeProcess(pid);
      }

      return isRunning;
    } catch (error) {
      this.removeProcess(pid);
      return false;
    }
  }

  /**
   * Check if any tracked processes are writing to the requested files
   * Uses batch checking for efficiency
   */
  async hasActiveProcessesForFiles(
    sandbox: AnySandbox,
    filePaths: string[],
  ): Promise<{ active: boolean; processes: BackgroundProcess[] }> {
    const activeProcesses: BackgroundProcess[] = [];

    // Check each process individually
    for (const [pid, process] of this.processes.entries()) {
      const isRunning = await this.checkProcessStatus(sandbox, pid);

      if (isRunning) {
        const hasMatchingFile = process.outputFiles.some((outputFile) =>
          filePaths.some((requestedFile) => {
            const normalizedOutput = this.normalizePath(outputFile);
            const normalizedRequested = this.normalizePath(requestedFile);

            return (
              normalizedOutput === normalizedRequested ||
              normalizedOutput.endsWith("/" + normalizedRequested) ||
              normalizedRequested.endsWith("/" + normalizedOutput) ||
              normalizedOutput.endsWith(normalizedRequested) ||
              normalizedRequested.endsWith(normalizedOutput)
            );
          }),
        );

        if (hasMatchingFile) {
          activeProcesses.push(process);
        }
      }
    }

    return {
      active: activeProcesses.length > 0,
      processes: activeProcesses,
    };
  }

  /**
   * Normalize file path for comparison
   */
  private normalizePath(path: string): string {
    // Remove leading/trailing spaces and normalize slashes
    let normalized = path.trim().replace(/\/+/g, "/");

    // Remove leading ./ if present
    if (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
    }

    return normalized;
  }

  /**
   * Extract output file paths from a command string
   */
  static extractOutputFiles(command: string): string[] {
    const outputFiles: string[] = [];

    // Pattern 1: nmap -oN file, -oX file, -oG file
    const nmapPatterns = [
      /-oN\s+([^\s]+)/g,
      /-oX\s+([^\s]+)/g,
      /-oG\s+([^\s]+)/g,
    ];

    for (const pattern of nmapPatterns) {
      let match;
      while ((match = pattern.exec(command)) !== null) {
        const filename = match[1].replace(/^['"]|['"]$/g, "");
        outputFiles.push(filename);
      }
    }

    // Pattern 2: nmap -oA prefix (creates prefix.nmap, prefix.xml, prefix.gnmap)
    const nmapAllPattern = /-oA\s+([^\s]+)/g;
    let match;
    while ((match = nmapAllPattern.exec(command)) !== null) {
      const prefix = match[1];
      outputFiles.push(`${prefix}.nmap`, `${prefix}.xml`, `${prefix}.gnmap`);
    }

    // Pattern 3: Shell redirection > file or >> file
    const redirectPattern = /(?:^|[|;&])\s*[^|;&]*?\s+>>?\s+([^\s|;&]+)/g;
    while ((match = redirectPattern.exec(command)) !== null) {
      const filename = match[1].replace(/^['"]|['"]$/g, "");
      outputFiles.push(filename);
    }

    // Pattern 4: tee file
    const teePattern = /\|\s*tee\s+([^\s|;&]+)/g;
    while ((match = teePattern.exec(command)) !== null) {
      const filename = match[1].replace(/^['"]|['"]$/g, "");
      outputFiles.push(filename);
    }

    // Pattern 5: Generic --output file or -o file
    const genericPatterns = [/--output\s+([^\s]+)/g, /(?:^|\s)-o\s+([^\s]+)/g];

    for (const pattern of genericPatterns) {
      while ((match = pattern.exec(command)) !== null) {
        const filename = match[1].replace(/^['"]|['"]$/g, "");
        outputFiles.push(filename);
      }
    }

    // Pattern 6: archive creation (zip/tar/7z/rar). These pass the archive
    // path as a bare positional argument, not a flagged one -- none of the
    // patterns above see it, so a background `zip -r out.zip dir/` was never
    // tracked and a `get_terminal_files` call right after could upload a
    // zero-byte or half-written archive with no warning. Match by the
    // archive's own file extension rather than trying to parse every tool's
    // argument grammar; matching a stray mention too eagerly only costs a
    // retry, while missing a real one silently delivers a broken file.
    const archiveExtensionPattern =
      /([^\s"']+\.(?:tar\.gz|tar\.bz2|tgz|tbz2|zip|tar|7z|rar))\b/gi;
    while ((match = archiveExtensionPattern.exec(command)) !== null) {
      outputFiles.push(match[1]);
    }

    return [...new Set(outputFiles)];
  }

  /**
   * Get all tracked processes (for debugging)
   */
  getTrackedProcesses(): BackgroundProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Clear all tracked processes
   */
  clear(): void {
    this.processes.clear();
  }
}

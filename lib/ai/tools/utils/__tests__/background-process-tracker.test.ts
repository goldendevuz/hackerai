import { BackgroundProcessTracker } from "../background-process-tracker";

describe("BackgroundProcessTracker.extractOutputFiles", () => {
  it("still recognizes redirection, tee and -o/--output targets", () => {
    expect(
      BackgroundProcessTracker.extractOutputFiles("echo hi > out.txt"),
    ).toEqual(["out.txt"]);
    expect(
      BackgroundProcessTracker.extractOutputFiles("cmd | tee log.txt"),
    ).toEqual(["log.txt"]);
    expect(
      BackgroundProcessTracker.extractOutputFiles("gobuster -o result.txt"),
    ).toEqual(["result.txt"]);
  });

  it("recognizes a zip archive's bare positional output argument", () => {
    // Regression: `zip` takes its archive path as a positional argument, not
    // a flag, so none of the existing patterns ever saw it -- a background
    // zip and an immediate get_terminal_files call raced, uploading a
    // zero-byte or half-written archive with no warning.
    expect(
      BackgroundProcessTracker.extractOutputFiles(
        "zip -r pdaftar_retest_bundle_20261102.zip evidence/",
      ),
    ).toEqual(["pdaftar_retest_bundle_20261102.zip"]);
  });

  it("recognizes tar, 7z and rar archive outputs", () => {
    expect(
      BackgroundProcessTracker.extractOutputFiles(
        "tar -czf backup.tar.gz /home/user/data",
      ),
    ).toEqual(["backup.tar.gz"]);
    expect(
      BackgroundProcessTracker.extractOutputFiles("7z a archive.7z dir/"),
    ).toEqual(["archive.7z"]);
    expect(
      BackgroundProcessTracker.extractOutputFiles("rar a bundle.rar dir/"),
    ).toEqual(["bundle.rar"]);
  });
});

describe("BackgroundProcessTracker.hasActiveProcessesForFiles", () => {
  it("flags a running background zip as still writing its own output path", async () => {
    const tracker = new BackgroundProcessTracker();
    const pid = 4242;
    tracker.addProcess(
      pid,
      "zip -r evidence_bundle.zip evidence/",
      BackgroundProcessTracker.extractOutputFiles(
        "zip -r evidence_bundle.zip evidence/",
      ),
    );
    const sandbox = {
      commands: {
        run: jest.fn().mockResolvedValue({ stdout: String(pid) }),
      },
    } as any;

    const result = await tracker.hasActiveProcessesForFiles(sandbox, [
      "evidence_bundle.zip",
    ]);
    expect(result.active).toBe(true);
    expect(result.processes).toHaveLength(1);
  });
});

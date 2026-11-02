import "@testing-library/jest-dom";
import {
  render,
  waitFor,
  act,
  screen,
  fireEvent,
} from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import {
  setMockConvexAuth,
  resetMockConvexAuth,
} from "@/__mocks__/convex-react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { FileUrlCacheProvider } from "@/app/contexts/FileUrlCacheContext";
import { AllFilesDialog } from "../AllFilesDialog";

jest.mock("@/convex/_generated/api", () => ({
  api: {
    s3Actions: {
      getFileUrlsBatchAction: "s3Actions.getFileUrlsBatchAction",
    },
  },
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("@/app/hooks/useTauri", () => ({
  isTauriEnvironment: jest.fn(() => false),
  openDownloadsFolder: jest.fn(),
}));

function CommitProbe({
  children,
  onCommit,
}: {
  children: ReactNode;
  onCommit: () => void;
}) {
  useLayoutEffect(onCommit);
  return children;
}

describe("AllFilesDialog", () => {
  let mockGetFileUrlsBatchAction: jest.Mock;
  let cache: Map<string, string>;

  beforeEach(() => {
    resetMockConvexAuth();
    mockGetFileUrlsBatchAction = useAction({} as any) as unknown as jest.Mock;
    mockGetFileUrlsBatchAction.mockReset();
    cache = new Map();
  });

  afterEach(() => resetMockConvexAuth());

  function cachedDialog(
    files: React.ComponentProps<typeof AllFilesDialog>["files"],
  ) {
    return (
      <FileUrlCacheProvider
        getCachedUrl={(fileId) => cache.get(fileId) ?? null}
        setCachedUrl={(fileId, url) => cache.set(fileId, url)}
      >
        <AllFilesDialog
          open={true}
          onOpenChange={jest.fn()}
          files={files}
          chatTitle="Files"
        />
      </FileUrlCacheProvider>
    );
  }

  const renderWithCache = (
    files: React.ComponentProps<typeof AllFilesDialog>["files"],
  ) => render(cachedDialog(files));

  it("fetches dialog file URLs in 50-file batches instead of per-file actions", async () => {
    mockGetFileUrlsBatchAction.mockImplementation(
      async ({ fileIds }: { fileIds: string[] }) => {
        return Object.fromEntries(
          fileIds.map((fileId) => [fileId, `https://files.example/${fileId}`]),
        );
      },
    );

    const files = Array.from({ length: 51 }, (_, index) => {
      const fileId = `file-${index}`;
      return {
        part: {
          fileId: fileId as any,
          name: `${fileId}.txt`,
          mediaType: "text/plain",
          s3Key: `uploads/${fileId}.txt`,
        },
        partIndex: index,
        messageId: "message-1",
      };
    });

    renderWithCache(files);

    await waitFor(() => {
      expect(mockGetFileUrlsBatchAction).toHaveBeenCalledTimes(2);
      expect(cache.size).toBe(51);
    });

    expect(mockGetFileUrlsBatchAction.mock.calls[0][0].fileIds).toHaveLength(
      50,
    );
    expect(mockGetFileUrlsBatchAction.mock.calls[1][0].fileIds).toEqual([
      "file-50",
    ]);
  });

  it("does not request URLs before authentication and resumes when ready", async () => {
    setMockConvexAuth({ isAuthenticated: false, isLoading: true });
    mockGetFileUrlsBatchAction.mockResolvedValue({
      "file-0": "https://files.example/0",
    });
    const files = [
      {
        part: {
          fileId: "file-0" as any,
          name: "image.png",
          mediaType: "image/png",
          s3Key: "uploads/image",
        },
        partIndex: 0,
        messageId: "message",
      },
    ];
    const view = renderWithCache(files);
    expect(mockGetFileUrlsBatchAction).not.toHaveBeenCalled();
    setMockConvexAuth({ isAuthenticated: true, isLoading: false });
    view.rerender(cachedDialog(files));
    await waitFor(() =>
      expect(cache.get("file-0")).toBe("https://files.example/0"),
    );
  });

  it("stops remaining dialog batches and discards their late URLs after auth loss", async () => {
    let finish!: (urls: Record<string, string>) => void;
    mockGetFileUrlsBatchAction.mockReturnValue(
      new Promise((r) => {
        finish = r;
      }),
    );
    const files = Array.from({ length: 51 }, (_, i) => ({
      part: {
        fileId: `file-${i}` as any,
        name: `file-${i}.txt`,
        mediaType: "text/plain",
        s3Key: `uploads/${i}`,
      },
      partIndex: i,
      messageId: "message",
    }));
    const view = renderWithCache(files);
    expect(mockGetFileUrlsBatchAction).toHaveBeenCalledTimes(1);
    setMockConvexAuth({ isAuthenticated: false });
    view.rerender(cachedDialog(files));
    await act(async () => finish({ "file-0": "https://files.example/late" }));
    expect(mockGetFileUrlsBatchAction).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });

  it("does not expose old download URLs in the reauthenticated commit before effects run", async () => {
    let finishNew!: (urls: Record<string, string>) => void;
    mockGetFileUrlsBatchAction
      .mockResolvedValueOnce({ "file-0": "https://files.example/old" })
      .mockReturnValueOnce(
        new Promise((r) => {
          finishNew = r;
        }),
      );
    const files = [
      {
        part: {
          fileId: "file-0" as any,
          name: "file.txt",
          mediaType: "text/plain",
          s3Key: "uploads/file",
        },
        partIndex: 0,
        messageId: "message",
      },
    ];
    const commits: boolean[] = [];
    const element = () => (
      <CommitProbe
        onCommit={() => {
          commits.push(
            Boolean(screen.queryByRole("button", { name: "Download file" })),
          );
        }}
      >
        {cachedDialog(files)}
      </CommitProbe>
    );
    const view = render(element());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Download file" }),
      ).toBeInTheDocument(),
    );
    setMockConvexAuth({ isAuthenticated: false });
    view.rerender(element());
    // The real message cache clears on auth loss; isolate the dialog's own URL state.
    cache.clear();
    commits.length = 0;
    setMockConvexAuth({ isAuthenticated: true });
    view.rerender(element());
    expect(commits.length).toBeGreaterThan(0);
    expect(commits).not.toContain(true);
    await act(async () =>
      finishNew({ "file-0": "https://files.example/current" }),
    );
    expect(
      screen.getByRole("button", { name: "Download file" }),
    ).toBeInTheDocument();
  });

  describe("batch download", () => {
    const originalFetch = global.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    beforeEach(() => {
      URL.createObjectURL = jest.fn(() => "blob:mock-url");
      URL.revokeObjectURL = jest.fn();
      (toast.success as jest.Mock).mockClear();
      (toast.error as jest.Mock).mockClear();
    });

    afterEach(() => {
      global.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });

    const filesWithUrls = Array.from({ length: 2 }, (_, i) => ({
      part: {
        fileId: `file-${i}` as any,
        name: `file-${i}.txt`,
        mediaType: "text/plain",
        s3Key: `uploads/${i}`,
        url: `https://files.example/file-${i}`,
      },
      partIndex: i,
      messageId: "message",
    }));

    const enterSelectionAndBatchDownload = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download files" }));
      const batchButton = await screen.findByRole("button", {
        name: /Batch download/,
      });
      fireEvent.click(batchButton);
    };

    it("errors instead of silently downloading an empty zip when every file fetch fails", async () => {
      // Regression: a presigned URL fetch (CORS, expired URL, ownership
      // mismatch) failing for every selected file used to be swallowed --
      // JSZip still produced a well-formed zero-entry zip and the download
      // reported success, hiding the real failure from the user.
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        blob: async () => new Blob([]),
      }) as any;

      renderWithCache(filesWithUrls);
      await enterSelectionAndBatchDownload();

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          "Failed to create ZIP file",
          expect.objectContaining({
            description: expect.stringContaining("None"),
          }),
        );
      });
      expect(toast.success).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it("downloads a non-empty zip and reports the real added count when all fetches succeed", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: async () => new Blob(["content"]),
      }) as any;

      renderWithCache(filesWithUrls);
      await enterSelectionAndBatchDownload();

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith(
          expect.stringContaining("Downloaded 2 files"),
          expect.anything(),
        );
      });
      expect(toast.error).not.toHaveBeenCalled();
      expect(URL.createObjectURL).toHaveBeenCalled();
    });
  });
});

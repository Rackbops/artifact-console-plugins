// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const hostFetch = vi.fn()
vi.mock("@ac/host", () => ({ fetch: (...args: unknown[]) => hostFetch(...args) }))

const { HelloRemotePanel, HelloRemoteCard } = await import("./ui.js")

afterEach(() => {
  cleanup()
  hostFetch.mockReset()
})

test("HelloRemotePanel fetches /api/x/hello-remote/ping and shows the greeting", async () => {
  hostFetch.mockResolvedValue({
    json: async () => ({ greeting: "hello from an installed plugin" }),
  })
  render(<HelloRemotePanel />)
  expect(hostFetch).toHaveBeenCalledWith("/api/x/hello-remote/ping")
  await waitFor(() => expect(screen.getByText("hello from an installed plugin")).toBeTruthy())
})

test("HelloRemotePanel shows 'unavailable' when the fetch rejects", async () => {
  hostFetch.mockRejectedValue(new Error("network error"))
  render(<HelloRemotePanel />)
  await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy())
})

test("HelloRemoteCard renders its static text", () => {
  render(<HelloRemoteCard />)
  expect(screen.getByText("Installed from the artifact-console-plugins index.")).toBeTruthy()
})

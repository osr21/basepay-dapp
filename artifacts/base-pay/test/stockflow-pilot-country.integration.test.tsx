import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  useListStockflowPilotParticipants: () => ({ data: [], isLoading: false, isError: false }),
  getListStockflowPilotParticipantsQueryKey: () => ["/api/stockflow/pilot/participants"],
  getGetStockflowPilotSessionQueryKey: () => ["/api/stockflow/pilot/session"],
  useSaveStockflowPilotParticipant: () => ({ mutate: api.mutate, isPending: false }),
}));
vi.mock("../src/lib/wagmi", () => ({ truncateAddress: (value: string) => value }));

import { PilotAdmin } from "../src/components/stockflow/PilotAdmin";

function openForm(country: string) {
  render(<QueryClientProvider client={new QueryClient()}><PilotAdmin /></QueryClientProvider>);
  fireEvent.click(screen.getByTestId("button-new-participant"));
  fireEvent.change(screen.getByTestId("input-participant-wallet"), { target: { value: "0x1111111111111111111111111111111111111111" } });
  fireEvent.change(screen.getByTestId("input-participant-country"), { target: { value: country } });
  fireEvent.change(screen.getByTestId("input-participant-days"), { target: { value: "1" } });
}

describe("pilot participant country input", () => {
  beforeEach(() => { cleanup(); api.mutate.mockReset(); });

  it.each(["UK", "uk", "GB"])("submits %s as canonical GB with the operator's one-day review", (country) => {
    openForm(country);
    fireEvent.click(screen.getByTestId("checkbox-participant-review"));
    fireEvent.click(screen.getByTestId("button-save-participant"));
    expect(api.mutate).toHaveBeenCalledWith({ data: {
      wallet: "0x1111111111111111111111111111111111111111",
      countryCode: "GB", days: 1, approved: true, reviewConfirmed: true,
    } }, expect.any(Object));
  });

  it("shows GB after leaving a UK input and never checks review automatically", () => {
    openForm("UK");
    fireEvent.blur(screen.getByTestId("input-participant-country"));
    expect((screen.getByTestId("input-participant-country") as HTMLInputElement).value).toBe("GB");
    expect((screen.getByTestId("checkbox-participant-review") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("button-save-participant") as HTMLButtonElement).disabled).toBe(true);
    expect(api.mutate).not.toHaveBeenCalled();
  });

  it("rejects submission without the required operator review", () => {
    openForm("UK");
    fireEvent.submit(screen.getByTestId("input-participant-country").closest("form")!);
    expect(screen.getByText("Confirm the operator review before approving.")).toBeTruthy();
    expect(api.mutate).not.toHaveBeenCalled();
  });
});

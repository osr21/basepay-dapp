import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { OnchainKitProvider } from "@coinbase/onchainkit";
import { base } from "viem/chains";
import { config } from "@/lib/wagmi";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import SendPage from "@/pages/Send";
import BatchPayPage from "@/pages/BatchPay";
import RequestPage from "@/pages/Request";
import RequestsPage from "@/pages/Requests";
import EscrowPage from "@/pages/Escrow";
import SubscriptionsPage from "@/pages/Subscriptions";
import ContactsPage from "@/pages/Contacts";
import PayPage from "@/pages/Pay";
import AppInfoPage from "@/pages/AppInfo";
import GaslessTransferPage from "@/pages/GaslessTransfer";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const ONCHAINKIT_API_KEY = import.meta.env.VITE_ONCHAINKIT_API_KEY as string | undefined;

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/send" component={SendPage} />
        <Route path="/batch-pay" component={BatchPayPage} />
        <Route path="/request" component={RequestPage} />
        <Route path="/requests" component={RequestsPage} />
        <Route path="/escrow" component={EscrowPage} />
        <Route path="/subscriptions" component={SubscriptionsPage} />
        <Route path="/contacts" component={ContactsPage} />
        <Route path="/app-info" component={AppInfoPage} />
        <Route path="/gasless" component={GaslessTransferPage} />
        <Route path="/pay/:id" component={PayPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={ONCHAINKIT_API_KEY}
          chain={base}
        >
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import contactsRouter from "./contacts";
import paymentRequestsRouter from "./paymentRequests";
import statsRouter from "./stats";
import appRouter from "./app";
import gaslessRouter from "./gasless";
import swapRouter from "./swap";
import x402relayRouter from "./x402relay";
import developerRouter from "./developer";
import cctpRouter from "./cctp";
import stockflowRouter from "./stockflow";
import stockflowPilotRouter from "./stockflow-pilot";
import stockflowIncomeRouter from "./stockflowIncome";

const router: IRouter = Router();

router.use(healthRouter);
router.use(contactsRouter);
router.use(paymentRequestsRouter);
router.use(statsRouter);
router.use(appRouter);
router.use(gaslessRouter);
router.use(swapRouter);
router.use(x402relayRouter);
router.use(developerRouter);
router.use(cctpRouter);
router.use(stockflowRouter);
router.use(stockflowPilotRouter);
router.use(stockflowIncomeRouter);

export default router;

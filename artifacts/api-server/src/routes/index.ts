import { Router, type IRouter } from "express";
import healthRouter from "./health";
import contactsRouter from "./contacts";
import paymentRequestsRouter from "./paymentRequests";
import statsRouter from "./stats";
import appRouter from "./app";
import gaslessRouter from "./gasless";
import x402relayRouter from "./x402relay";

const router: IRouter = Router();

router.use(healthRouter);
router.use(contactsRouter);
router.use(paymentRequestsRouter);
router.use(statsRouter);
router.use(appRouter);
router.use(gaslessRouter);
router.use(x402relayRouter);

export default router;

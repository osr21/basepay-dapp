import { Router, type IRouter } from "express";
import healthRouter from "./health";
import contactsRouter from "./contacts";
import paymentRequestsRouter from "./paymentRequests";
import statsRouter from "./stats";
import appRouter from "./app";
import gaslessRouter from "./gasless";
import swapRouter from "./swap";
import x402relayRouter from "./x402relay";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(contactsRouter);
router.use(paymentRequestsRouter);
router.use(statsRouter);
router.use(appRouter);
router.use(gaslessRouter);
router.use(swapRouter);
router.use(x402relayRouter);
router.use(adminRouter);

export default router;

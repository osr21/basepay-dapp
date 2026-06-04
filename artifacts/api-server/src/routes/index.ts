import { Router, type IRouter } from "express";
import healthRouter from "./health";
import contactsRouter from "./contacts";
import paymentRequestsRouter from "./paymentRequests";
import statsRouter from "./stats";
import appRouter from "./app";
import gaslessRouter from "./gasless";

const router: IRouter = Router();

router.use(healthRouter);
router.use(contactsRouter);
router.use(paymentRequestsRouter);
router.use(statsRouter);
router.use(appRouter);
router.use(gaslessRouter);

export default router;

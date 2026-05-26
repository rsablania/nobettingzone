import { Router, type IRouter } from "express";
import healthRouter from "./health";
import replRouter from "./repl";

const router: IRouter = Router();

router.use(healthRouter);
router.use(replRouter);

export default router;

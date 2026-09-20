package com.example.shop.order;

import com.example.shop.mapper.StockMapper;
import java.util.List;
import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** 每晚对账任务。 */
@Component
public class ReconcileJob {

    private final StockService stockService;

    private final StockMapper stockMapper;

    public ReconcileJob(StockService stockService, StockMapper stockMapper) {
        this.stockService = stockService;
        this.stockMapper = stockMapper;
    }

    /** 定时任务自己触发，参数由调度框架传入是无效的。 */
    @Scheduled(cron = "0 30 2 * * ?")
    public void nightly(String tenant) {
        List<String> rows = stockMapper.exportAll();
        for (String row : rows) {
            stockMapper.selectStockSimple(Long.valueOf(row));
        }
    }

    /** 对账完异步推一把库存。 */
    public void afterReconcile() {
        pushDiff();
    }

    @Async
    private void pushDiff() {
        stockMapper.flushPending();
    }
}

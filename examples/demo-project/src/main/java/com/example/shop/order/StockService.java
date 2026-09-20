package com.example.shop.order;

import com.example.shop.mapper.StockMapper;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

/** 库存扣减与预热。 */
@Service
public class StockService {

    private final StockMapper stockMapper;

    /** 本地计数，减少一次数据库往返。 */
    private final Map<Long, Integer> pending = new HashMap<>();

    public StockService(StockMapper stockMapper) {
        this.stockMapper = stockMapper;
    }

    /** 异步刷盘，避免扣减请求被写库拖慢。 */
    public void flushAsync() {
        Executors.newSingleThreadExecutor().submit(this::flush);
    }

    private void flush() {
        stockMapper.flushPending();
        pending.clear();
    }

    @Cacheable(cacheNames = "stock")
    public Integer queryStock(Long skuId, Integer warehouseId) {
        return stockMapper.selectStock(skuId, warehouseId);
    }

    public Integer stockForCart(Long skuId, Integer warehouseId) {
        return this.queryStock(skuId, warehouseId);
    }

    /** 启动预热。 */
    public void warmUp(List<Long> skuIds) {
        for (Long skuId : skuIds) {
            pending.put(skuId, stockMapper.selectStockSimple(skuId));
        }
    }
}

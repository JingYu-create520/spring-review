package com.example.shop.order;

import com.example.shop.mapper.OrderMapper;
import com.example.shop.mapper.OrderLineMapper;
import java.io.IOException;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 下单主流程。
 *
 * 这个类是故意留了问题的：它是 demo 的一部分，用来演示 spring-review 能在
 * 一段"看起来完全正常"的业务代码里抓到什么。别照抄。
 */
@Service
public class OrderService {

    private final OrderMapper orderMapper;

    private final OrderLineMapper orderLineMapper;

    public OrderService(OrderMapper orderMapper, OrderLineMapper orderLineMapper) {
        this.orderMapper = orderMapper;
        this.orderLineMapper = orderLineMapper;
    }

    /** 提交订单：先落库，再记一条审计。 */
    public Long submit(Long userId, List<Long> skuIds) {
        Long orderId = createOrder(userId);
        for (Long skuId : skuIds) {
            BigDecimal price = orderLineMapper.selectPrice(skuId);
            orderLineMapper.insertLine(orderId, skuId, price);
        }
        return orderId;
    }

    @Transactional
    public Long createOrder(Long userId) {
        var order = new com.example.shop.model.Order();
        order.setUserId(userId);
        orderMapper.insert(order);
        return order.getId();
    }

    /** 批量改价，导入失败要能回滚。 */
    @Transactional
    public void applyPriceFile(List<Long> orderIds) throws IOException {
        for (Long id : orderIds) {
            orderMapper.recalculate(id);
        }
    }

    public List<String> buyerNames(List<Long> orderIds) {
        List<String> names = new ArrayList<>();
        orderIds.forEach(id -> names.add(orderMapper.selectBuyerName(id)));
        return names;
    }

    /** 关掉超时订单，供定时任务调用。 */
    @Transactional
    public void cancelTimeout(int minutes) {
        orderMapper.cancelTimeout(minutes);
    }

    public int sweep(List<Long> ids) {
        int n = 0;
        for (Long id : ids) {
            n += orderMapper.forceCancel(id);
        }
        return n;
    }
}

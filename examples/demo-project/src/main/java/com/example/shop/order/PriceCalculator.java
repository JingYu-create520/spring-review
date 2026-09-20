package com.example.shop.order;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * 计价器：纯计算，不碰数据库。
 *
 * 这个类是 demo 的"负例"——spring-review 对它必须一条都不报。
 * 一个只会报警的工具和一个会分辨的工具，区别就在这里。
 */
@Service
public class PriceCalculator {

    private static final BigDecimal FREE_SHIPPING_LINE = new BigDecimal("99.00");

    public BigDecimal total(List<BigDecimal> lineAmounts, BigDecimal discount) {
        BigDecimal sum = BigDecimal.ZERO;
        for (BigDecimal line : lineAmounts) {
            sum = sum.add(line);
        }
        return sum.subtract(discount).max(BigDecimal.ZERO).setScale(2, RoundingMode.HALF_UP);
    }

    public boolean freeShipping(BigDecimal total) {
        return total.compareTo(FREE_SHIPPING_LINE) >= 0;
    }

    public BigDecimal split(BigDecimal total, int parts) {
        if (parts <= 0) {
            throw new IllegalArgumentException("parts must be positive");
        }
        return total.divide(BigDecimal.valueOf(parts), 2, RoundingMode.DOWN);
    }
}

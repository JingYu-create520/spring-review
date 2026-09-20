package com.example.shop.model;

import java.math.BigDecimal;
import java.time.LocalDateTime;

/** 价格规则。 */
public class PriceRule {

    public Long id;

    public String ruleName;

    public BigDecimal rate;

    public String channel;

    public Integer priority;

    public Boolean enabled;

    public LocalDateTime effectiveAt;

    public LocalDateTime updatedAt;
}

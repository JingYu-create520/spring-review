package com.example.shop.mapper;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface OrderLineMapper {

    java.math.BigDecimal selectPrice(@Param("skuId") Long skuId);

    void insertLine(@Param("orderId") Long orderId, @Param("skuId") Long skuId, @Param("price") java.math.BigDecimal price);
}

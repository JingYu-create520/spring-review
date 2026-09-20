package com.example.shop.mapper;

import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface StockMapper {

    Integer selectStock(@Param("skuId") Long skuId, @Param("warehouseId") Integer warehouseId);

    Integer selectStockSimple(@Param("skuId") Long skuId);

    void flushPending();

    List<String> exportAll();

    List<String> searchSku(@Param("keyword") String keyword);
}

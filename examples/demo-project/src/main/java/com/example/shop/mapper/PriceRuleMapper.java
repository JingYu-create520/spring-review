package com.example.shop.mapper;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.example.shop.model.PriceRule;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface PriceRuleMapper {

    java.util.List<PriceRule> selectEffective(@Param("channel") String channel);

    long countByChannel(@Param("channel") String channel);

    /** 分页由拦截器注入，SQL 里没有 LIMIT 也不是无界查询。 */
    IPage<PriceRule> selectPage(IPage<PriceRule> page, @Param("channel") String channel);

    void touch(@Param("id") Long id);
}

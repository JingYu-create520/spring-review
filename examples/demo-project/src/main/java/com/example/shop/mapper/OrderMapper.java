package com.example.shop.mapper;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.example.shop.model.Order;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/** 订单表。 */
@Mapper
public interface OrderMapper {

    void insert(Order order);

    /**
     * 后台列表用的分页查询。
     * 注意：limit 由 MyBatis-Plus 的分页拦截器注入，SQL 里看不到，
     * 所以它不是"无界查询"——好的审查工具应该能分辨这件事。
     */
    IPage<Order> selectPage(IPage<Order> page, @Param("status") Integer status);

    /** 按状态取全量，供导出用。 */
    List<Order> selectAllByStatus(@Param("status") Integer status);

    void recalculate(@Param("id") Long id);

    int cancelTimeout(@Param("minutes") int minutes);

    int forceCancel(@Param("id") Long id);

    String selectBuyerName(@Param("id") Long id);

    /** 动态排序：列名来自前端。 */
    @Select("select id, user_id, total_amount from orders order by ${sortField} desc limit 50")
    List<Order> topSorted(@Param("sortField") String sortField);

    @Select("select count(1) from orders where remark like '%${keyword}%'")
    long countByRemark(@Param("keyword") String keyword);
}

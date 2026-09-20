package com.example.demo.mapper;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.example.demo.model.User;
import java.util.List;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * 配套 CleanUserMapper.xml 的接口。分页由 MyBatis-Plus 拦截器注入,
 * XML 里没有 LIMIT 也不该被 MYB005 报出来 —— 这个文件就是用来证明这一点。
 */
@Mapper
public interface UserMapper {

    List<User> selectByStatus(@Param("status") int status, @Param("limit") int limit);

    List<User> searchPrefix(@Param("keyword") String keyword);

    long countByDept(@Param("deptId") long deptId);

    IPage<User> selectPage(IPage<User> page, @Param("status") int status);

    User selectById(@Param("id") Long id);

    List<User> selectByIds(@Param("ids") List<Long> ids);
}
